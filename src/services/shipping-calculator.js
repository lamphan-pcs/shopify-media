const axios = require("axios");

class ShippingCalculator {
    constructor(domain, accessToken) {
        this.domain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
        this.accessToken = accessToken;
        this.baseUrl = `https://${this.domain}/admin/api/2024-01/graphql.json`;
    }

    async fetchProductByHandle(handle) {
        console.log(`[Shipping] Looking up product: "${handle}"`);
        const query = `
        query($handle: String!) {
            productByHandle(handle: $handle) {
                id
                title
                variants(first: 100) {
                    edges {
                        node {
                            id
                            title
                            sku
                            inventoryItem {
                                measurement {
                                    weight {
                                        value
                                        unit
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }`;

        const data = await this._request(query, { handle });
        const product = data.productByHandle;

        if (!product) {
            console.log(`[Shipping] Product not found: "${handle}"`);
            return null;
        }

        const variants = product.variants.edges.map((e) => e.node);
        console.log(
            `[Shipping] Found "${product.title}" — ${variants.length} variant(s): ` +
            variants.map((v) => {
                const w = v.inventoryItem?.measurement?.weight;
                return `${v.title}=${w ? `${w.value}${w.unit}` : "no weight"}`;
            }).join(", ")
        );

        return { id: product.id, title: product.title, variants };
    }

    // Returns an array of { variantId, label, sku, weightStr } groups to calculate separately.
    // If all variants share the same weight, returns a single group (first variant, label: null).
    // If weights differ, returns one group per variant with label = variant title only.
    _getVariantGroups(variants) {
        const formatWeight = (v) => {
            const w = v.inventoryItem?.measurement?.weight;
            if (!w || w.value === null || w.value === undefined) return "";
            const unit = w.unit
                ? w.unit.charAt(0).toUpperCase() + w.unit.slice(1).toLowerCase()
                : "";
            return `${w.value} ${unit}`.trim();
        };

        if (variants.length === 0) return [];
        if (variants.length === 1) {
            return [{
                variantId: variants[0].id,
                label: null,
                sku: variants[0].sku || "",
                weightStr: formatWeight(variants[0]),
            }];
        }

        const getWeight = (v) => v.inventoryItem?.measurement?.weight?.value ?? null;
        const firstWeight = getWeight(variants[0]);
        const allSameWeight = variants.every((v) => {
            const w = getWeight(v);
            if (firstWeight === null && w === null) return true;
            if (firstWeight === null || w === null) return false;
            return Math.abs(w - firstWeight) < 0.0001;
        });

        if (allSameWeight) {
            const wStr = formatWeight(variants[0]);
            console.log(
                `[Shipping] All ${variants.length} variants have the same weight (${wStr || "unset"}), using first variant`
            );
            return [{
                variantId: variants[0].id,
                label: null,
                sku: variants[0].sku || "",
                weightStr: wStr,
            }];
        }

        console.log(`[Shipping] Variants have different weights — will calculate each separately`);
        return variants.map((v) => ({
            variantId: v.id,
            label: v.title,
            sku: v.sku || "",
            weightStr: formatWeight(v),
        }));
    }

    async calculateShippingForVariant(variantId, address, displayLabel) {
        console.log(
            `[Shipping] Calculating rates for "${displayLabel}" → ${address.city}, ${address.countryCode}`
        );
        const mutation = `
        mutation draftOrderCalculate($input: DraftOrderInput!) {
            draftOrderCalculate(input: $input) {
                calculatedDraftOrder {
                    availableShippingRates {
                        handle
                        title
                        price {
                            amount
                            currencyCode
                        }
                    }
                }
                userErrors {
                    field
                    message
                }
            }
        }`;

        const variables = {
            input: {
                lineItems: [{ variantId, quantity: 1 }],
                shippingAddress: {
                    address1: address.address1 || "",
                    city: address.city || "",
                    province: address.province || "",
                    zip: address.zip || "",
                    countryCode: address.countryCode || "",
                },
            },
        };

        const data = await this._request(mutation, variables);
        const result = data.draftOrderCalculate;

        if (result.userErrors && result.userErrors.length > 0) {
            const msgs = result.userErrors.map((e) => e.message).join("; ");
            console.error(`[Shipping] userErrors for "${displayLabel}": ${msgs}`);
            throw new Error(msgs);
        }

        const rates = result.calculatedDraftOrder.availableShippingRates || [];
        if (rates.length === 0) {
            console.log(
                `[Shipping] No rates returned for "${displayLabel}" to ${address.countryCode}`
            );
        } else {
            console.log(
                `[Shipping] ${rates.length} rate(s) for "${displayLabel}": ` +
                rates.map((r) => `${r.title}=${r.price.amount}${r.price.currencyCode}`).join(", ")
            );
        }

        return rates;
    }

    // Simple concurrency limiter (same pattern as downloader.js)
    _simpleLimit(concurrency) {
        const queue = [];
        let active = 0;

        const next = () => {
            if (active >= concurrency || queue.length === 0) return;
            active++;
            const { fn, resolve, reject } = queue.shift();
            fn()
                .then(resolve)
                .catch(reject)
                .finally(() => {
                    active--;
                    next();
                });
        };

        return (fn) =>
            new Promise((resolve, reject) => {
                queue.push({ fn, resolve, reject });
                next();
            });
    }

    // onProgress event shapes:
    //   { type: 'lookup',      handle, current, total }
    //   { type: 'calculating', handle, title, variantLabel, current, total }
    //   { type: 'row-done',    row, carriers, hasVariants, current, total }
    //   { type: 'complete',    carriers, hasVariants }
    async calculate(handles, address, onProgress = null) {
        const validHandles = handles.filter((h) => h.trim().length > 0);
        const total = validHandles.length;
        const CONCURRENCY = 5;

        console.log(
            `[Shipping] Starting — ${total} product(s), concurrency: ${CONCURRENCY} — ` +
            `${address.address1}, ${address.city} ${address.zip}, ${address.countryCode}`
        );

        const allRows = [];
        const carriersSet = new Set();
        let completed = 0;
        let hasVariants = false;

        const limit = this._simpleLimit(CONCURRENCY);

        const tasks = validHandles.map((handle) =>
            limit(async () => {
                const trimmed = handle.trim();
                const productRows = [];

                if (onProgress) {
                    onProgress({ type: "lookup", handle: trimmed, current: completed + 1, total });
                }

                try {
                    const product = await this.fetchProductByHandle(trimmed);

                    if (!product) {
                        productRows.push({
                            handle: trimmed, title: "", variant: null, sku: "", weight: "", rates: {}, error: "Product not found",
                        });
                    } else if (product.variants.length === 0) {
                        productRows.push({
                            handle: trimmed, title: product.title, variant: null, sku: "", weight: "", rates: {}, error: "No variants",
                        });
                    } else {
                        const groups = this._getVariantGroups(product.variants);

                        for (const group of groups) {
                            const displayLabel = group.label
                                ? `${product.title} (${group.label})`
                                : product.title;

                            if (group.label) hasVariants = true;

                            if (onProgress) {
                                onProgress({
                                    type: "calculating",
                                    handle: trimmed,
                                    title: product.title,
                                    variantLabel: group.label,
                                    current: completed + 1,
                                    total,
                                });
                            }

                            const row = {
                                handle: trimmed,
                                title: product.title,
                                variant: group.label,
                                sku: group.sku,
                                weight: group.weightStr,
                                rates: {},
                                error: null,
                            };

                            try {
                                const rates = await this.calculateShippingForVariant(
                                    group.variantId,
                                    address,
                                    displayLabel
                                );

                                for (const rate of rates) {
                                    row.rates[rate.title] = `${rate.price.amount} ${rate.price.currencyCode}`;
                                    carriersSet.add(rate.title);
                                }

                                console.log(
                                    `[Shipping] "${displayLabel}" — ${Object.keys(row.rates).length} carrier(s) found`
                                );
                            } catch (err) {
                                row.error = err.message;
                                console.error(`[Shipping] "${displayLabel}" — error: ${err.message}`);
                            }

                            productRows.push(row);
                        }
                    }
                } catch (err) {
                    productRows.push({
                        handle: trimmed, title: "", variant: null, sku: "", weight: "", rates: {}, error: err.message,
                    });
                    console.error(`[Shipping] "${trimmed}" — unexpected error: ${err.message}`);
                }

                completed++;
                console.log(`[Shipping] [${completed}/${total}] "${trimmed}" complete`);

                for (const row of productRows) {
                    allRows.push(row);
                    if (onProgress) {
                        onProgress({
                            type: "row-done",
                            row: { ...row },
                            carriers: Array.from(carriersSet).sort(),
                            hasVariants,
                            current: completed,
                            total,
                        });
                    }
                }
            })
        );

        await Promise.all(tasks);

        const carriers = Array.from(carriersSet).sort();
        console.log(
            `[Shipping] Complete. ${allRows.length} row(s), ${carriers.length} carrier(s): [${carriers.join(", ")}]`
        );

        if (onProgress) onProgress({ type: "complete", carriers, hasVariants });

        return { rows: allRows, carriers, hasVariants };
    }

    async _request(query, variables = {}) {
        try {
            const response = await axios.post(
                this.baseUrl,
                { query, variables },
                {
                    headers: {
                        "X-Shopify-Access-Token": this.accessToken,
                        "Content-Type": "application/json",
                    },
                    timeout: 30000,
                }
            );

            if (response.data.errors) {
                const msgs = response.data.errors.map((e) => e.message).join(", ");
                console.error(`[Shipping] GraphQL errors: ${msgs}`);
                throw new Error(`GraphQL Error: ${msgs}`);
            }

            return response.data.data;
        } catch (error) {
            if (error.response && error.response.status === 429) {
                console.warn("[Shipping] Rate limited by Shopify API");
                throw new Error("Rate Limited by Shopify");
            }
            console.error("[Shipping] Request failed:", error.message);
            throw error;
        }
    }
}

module.exports = ShippingCalculator;
