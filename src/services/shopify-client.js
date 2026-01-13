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
        metafieldKeysString = ""
    ) {
        console.log(
            `[Shopify] Fetching products. Cursor: ${cursor}, Metafields: ${metafieldKeysString}`
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
                    `[Shopify] Generating query for metafield: namespace=${namespace}, key=${key}`
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
                }
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
