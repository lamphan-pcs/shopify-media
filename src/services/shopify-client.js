const axios = require("axios");

class ShopifyClient {
    constructor(domain, accessToken) {
        this.domain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
        this.accessToken = accessToken;
        this.baseUrl = `https://${this.domain}/admin/api/2024-01/graphql.json`;
    }

    async validateConnection() {
        const query = `
        {
            shop {
                name
                myshopifyDomain
            }
        }`;

        try {
            const response = await this._request(query);
            return response.shop;
        } catch (error) {
            throw new Error(`Connection failed: ${error.message}`);
        }
    }

    async fetchProducts(
        lastSyncDate = null,
        cursor = null,
        metafieldKeysString = "",
    ) {
        console.log(
            `[Shopify] Fetching products. Cursor: ${cursor}, Metafields: ${metafieldKeysString}`,
        );

        // Construct filter
        let queryFilter = "";
        if (lastSyncDate) {
            queryFilter += ` updated_at:>'${lastSyncDate}'`;
        }

        // Build Metafields Query Segment
        let metafieldQuery = "";
        if (metafieldKeysString) {
            const keys = metafieldKeysString.split(",").map((k) => k.trim());
            keys.forEach((k, index) => {
                const part = k.split(".");
                let namespace = "custom";
                let key = k;

                if (part.length >= 2) {
                    namespace = part[0];
                    key = part.slice(1).join(".");
                }

                console.log(
                    `[Shopify] Generating query for metafield: namespace=${namespace}, key=${key}`,
                );

                metafieldQuery += `
                     mf_${index}: metafield(namespace: "${namespace}", key: "${key}") {
                        id
                        type
                        reference {
                           ... on MediaImage {
                               image {
                                   originalSrc: url
                                   id
                               }
                           }
                           ... on GenericFile {
                               originalSrc: url
                               id
                           }
                        }
                        references(first: 20) {
                            edges {
                                node {
                                   ... on MediaImage {
                                       image {
                                           originalSrc: url
                                           id
                                       }
                                   }
                                   ... on GenericFile {
                                       originalSrc: url
                                       id
                                   }
                                }
                            }
                        }
                     }`;
            });
        }

        const queryArg = queryFilter.trim()
            ? `, query: "${queryFilter.trim()}"`
            : "";

        const query = `
        query ($cursor: String) {
            products(first: 10, after: $cursor${queryArg}) {
                pageInfo {
                    hasNextPage
                    endCursor
                }
                edges {
                    node {
                        id
                        title
                        handle
                        updatedAt
                        tags
                        variants(first: 5) {
                            edges {
                                node {
                                    title
                                    sku
                                }
                            }
                        }
                        ${metafieldQuery}
                        media(first: 50) {
                            edges {
                                node {
                                    ... on MediaImage {
                                        id
                                        mediaContentType
                                        image {
                                            originalSrc: url
                                            id
                                            width
                                            height
                                        }
                                    }
                                    ... on Video {
                                        id
                                        mediaContentType
                                        sources {
                                            url
                                            mimeType
                                        }
                                    }
                                    ... on Model3d {
                                        id
                                        mediaContentType
                                        sources {
                                            url
                                            mimeType
                                        }
                                    }
                                    ... on ExternalVideo {
                                        id
                                        mediaContentType
                                        originUrl
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }`;

        return this._request(query, { cursor });
    }

    async reorderProductMedia(productId, moves = []) {
        if (!productId) {
            throw new Error("Missing product ID for media reorder");
        }
        if (!Array.isArray(moves) || moves.length < 2) {
            throw new Error("At least two media moves are required");
        }

        const toGraphqlMediaId = (id) => {
            const raw = String(id || "").trim();
            if (!raw) return raw;
            if (raw.startsWith("gid://")) return raw;

            const match = raw.match(/(\d+)$/);
            const numeric = match ? match[1] : raw;
            return `gid://shopify/MediaImage/${numeric}`;
        };

        // Shopify expects both id and newPosition as strings in MoveInput.
        const formattedMoves = moves.map((m) => ({
            id: toGraphqlMediaId(m.id),
            newPosition: String(Number(m.newPosition)),
        }));

        const mutation = `
        mutation productReorderMedia($id: ID!, $moves: [MoveInput!]!) {
            productReorderMedia(id: $id, moves: $moves) {
                job {
                    id
                }
                userErrors {
                    field
                    message
                }
                mediaUserErrors {
                    field
                    message
                }
            }
        }`;

        const data = await this._request(mutation, {
            id: productId,
            moves: formattedMoves,
        });

        const result = data.productReorderMedia;
        if (!result) {
            throw new Error("No result from productReorderMedia mutation");
        }

        const errors = [];
        (result.userErrors || []).forEach((e) => errors.push(e.message));
        (result.mediaUserErrors || []).forEach((e) => errors.push(e.message));

        if (errors.length > 0) {
            throw new Error(`Shopify reorder failed: ${errors.join(", ")}`);
        }

        return result.job || null;
    }

    async getProductIdByHandle(handle) {
        if (!handle) {
            throw new Error("Handle is required");
        }

        const query = `
        {
            productByHandle(handle: "${handle}") {
                id
            }
        }`;

        const data = await this._request(query);
        return data?.productByHandle?.id || null;
    }

    async getProductsForExport(
        metafieldKeysString = "",
        cursor = null,
        limit = 10,
    ) {
        console.log(
            `[Shopify] Fetching products for export. Cursor: ${cursor}, Limit: ${limit}`,
        );

        // Build Metafields Query Segment
        let metafieldQuery = "";
        if (metafieldKeysString) {
            const keys = metafieldKeysString.split(",").map((k) => k.trim());
            keys.forEach((k, index) => {
                const part = k.split(".");
                let namespace = "custom";
                let key = k;

                if (part.length >= 2) {
                    namespace = part[0];
                    key = part.slice(1).join(".");
                }

                metafieldQuery += `
                    mf_${index}: metafield(namespace: "${namespace}", key: "${key}") {
                        value
                        type
                    }`;
            });
        }

        // Also fetch standard Shopify metafields for SEO and other properties
        if (!metafieldQuery.includes("mm-google-shopping")) {
            metafieldQuery += `
                metafieldGoogleProduct: metafield(namespace: "mm-google-shopping", key: "custom_product") {
                    value
                    type
                }
                metafieldFragrance: metafield(namespace: "shopify", key: "fragrance") {
                    value
                }
                metafieldMoisturizerType: metafield(namespace: "shopify", key: "moisturizer-type") {
                    value
                }
                metafieldProductForm: metafield(namespace: "shopify", key: "product-form") {
                    value
                }`;
        }

        const query = `
        query ($cursor: String) {
            products(first: ${limit}, after: $cursor) {
                pageInfo {
                    hasNextPage
                    endCursor
                }
                edges {
                    node {
                        id
                        legacyResourceId
                        handle
                        title
                        bodyHtml
                        vendor
                        productType
                        tags
                        publishedAt
                        status
                        seoTitle: metafield(namespace: "seo", key: "title") {
                            value
                        }
                        seoDescription: metafield(namespace: "seo", key: "description") {
                            value
                        }
                        category {
                            name
                        }
                        options {
                            id
                            name
                            position
                            values
                        }
                        variants(first: 50) {
                            edges {
                                node {
                                    id
                                    legacyResourceId
                                    title
                                    sku
                                    barcode
                                    price
                                    compareAtPrice
                                    inventoryQuantity
                                    inventoryItem {
                                        id
                                        tracked
                                        requiresShipping
                                        sku
                                    }
                                    taxCode
                                    taxable
                                    image {
                                        id
                                        url
                                        altText
                                    }
                                }
                            }
                        }
                        images(first: 100) {
                            edges {
                                node {
                                    id
                                    url
                                    altText
                                }
                            }
                        }
                        ${metafieldQuery}
                    }
                }
            }
        }`;

        return this._request(query, { cursor });
    }

    async testExportData(metafieldKeysString = "", productLimit = 3) {
        console.log(`[Shopify] Testing export with ${productLimit} products`);
        const result = await this.getProductsForExport(
            metafieldKeysString,
            null,
            productLimit,
        );

        // Return raw data for inspection
        return {
            timestamp: new Date().toISOString(),
            productCount: result.products?.edges?.length || 0,
            products: result.products?.edges || [],
            pageInfo: result.products?.pageInfo || {},
        };
    }

    async getAllProductsForExport(metafieldKeysString = "", onProgress = null) {
        console.log("[Shopify] Starting full export of all products");
        const allProducts = [];
        let cursor = null;
        let pageCount = 0;
        const maxPages = 1000; // Safety limit
        const batchSize = 100; // Increased from 10 for faster export

        try {
            while (pageCount < maxPages) {
                const response = await this.getProductsForExport(
                    metafieldKeysString,
                    cursor,
                    batchSize,
                );

                const products = response.products?.edges || [];
                allProducts.push(...products);
                pageCount++;

                console.log(
                    `[Shopify] Export page ${pageCount}: fetched ${products.length} products (Total: ${allProducts.length})`,
                );

                // Notify progress
                if (onProgress) {
                    onProgress({
                        page: pageCount,
                        pageSize: products.length,
                        totalProducts: allProducts.length,
                        hasMore:
                            response.products?.pageInfo?.hasNextPage || false,
                    });
                }

                if (!response.products?.pageInfo?.hasNextPage) {
                    break;
                }

                cursor = response.products.pageInfo.endCursor;

                // Minimal delay to respect rate limits (25ms instead of 100ms)
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
        } catch (error) {
            console.error("[Shopify] Export error:", error.message);
            throw error;
        }

        console.log(
            `[Shopify] Export complete: ${allProducts.length} total products fetched in ${pageCount} pages`,
        );
        return allProducts;
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
                    timeout: 20000,
                },
            );

            if (response.data.errors) {
                const msgs = response.data.errors
                    .map((e) => e.message)
                    .join(", ");
                throw new Error(`GraphQL Error: ${msgs}`);
            }

            return response.data.data;
        } catch (error) {
            if (error.response && error.response.status === 429) {
                // Simple retry logic could go here, for now throw specifically
                throw new Error("Rate Limited");
            }
            throw error;
        }
    }
}

module.exports = ShopifyClient;
