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
        let queryFilter = "status:active";
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

        const query = `
        query ($cursor: String) {
            products(first: 10, after: $cursor, query: "${queryFilter}") {
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
