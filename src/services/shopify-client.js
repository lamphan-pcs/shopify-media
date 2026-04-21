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
        const metafieldQuery = this._buildMediaMetafieldQuery(
            metafieldKeysString,
            true,
        );

        const queryArg = queryFilter.trim()
            ? `, query: "${queryFilter.trim()}"`
            : "";

        const query = `
        query ($cursor: String) {
            products(first: 250, after: $cursor${queryArg}) {
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

    _parseMetafieldKeys(metafieldKeysString = "") {
        if (!metafieldKeysString) return [];

        return metafieldKeysString
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean)
            .map((k) => {
                const part = k.split(".");
                let namespace = "custom";
                let key = k;

                if (part.length >= 2) {
                    namespace = part[0];
                    key = part.slice(1).join(".");
                }

                return { namespace, key };
            });
    }

    _buildMediaMetafieldQuery(
        metafieldKeysString = "",
        includeLegacyIds = false,
    ) {
        const keys = this._parseMetafieldKeys(metafieldKeysString);
        if (keys.length === 0) return "";

        return keys
            .map(({ namespace, key }, index) => {
                console.log(
                    `[Shopify] Generating query for metafield: namespace=${namespace}, key=${key}`,
                );

                return `
                     mf_${index}: metafield(namespace: "${namespace}", key: "${key}") {
                        id
                        namespace
                        key
                        type
                        value
                        reference {
                           ... on MediaImage {
                               id
                               image {
                                   originalSrc: url
                                   id
                               }
                           }
                           ... on GenericFile {
                               id
                               originalSrc: url
                           }
                        }
                        references(first: 50) {
                            edges {
                                node {
                                   ... on MediaImage {
                                       id
                                       image {
                                           originalSrc: url
                                           id
                                       }
                                   }
                                   ... on GenericFile {
                                       id
                                       originalSrc: url
                                   }
                                }
                            }
                        }
                     }`;
            })
            .join("");
    }

    _classifyManagedMediaMetafield(key = "") {
        const normalized = String(key || "").toLowerCase();

        if (
            normalized.endsWith("bannerone") ||
            normalized.endsWith("banner_1")
        ) {
            return "banner";
        }

        if (
            normalized.endsWith("imagelistone") ||
            normalized.endsWith("image_list_1")
        ) {
            return "extra";
        }

        return null;
    }

    _getManagedMediaSlots(product, metafieldKeysString = "") {
        const parsedKeys = this._parseMetafieldKeys(metafieldKeysString);
        const slots = {
            banner: null,
            extra: null,
        };

        parsedKeys.forEach(({ namespace, key }, index) => {
            const slotType = this._classifyManagedMediaMetafield(key);
            if (!slotType || slots[slotType]) return;

            const metafield = product[`mf_${index}`] || null;
            slots[slotType] = {
                namespace,
                key,
                type:
                    metafield?.type ||
                    (slotType === "banner"
                        ? "file_reference"
                        : "list.file_reference"),
            };
        });

        return slots;
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

    async updateFileProductReferences(updates = []) {
        if (!Array.isArray(updates) || updates.length === 0) return null;

        const mutation = `
        mutation fileUpdate($files: [FileUpdateInput!]!) {
            fileUpdate(files: $files) {
                files {
                    id
                }
                userErrors {
                    field
                    message
                }
            }
        }`;

        const data = await this._request(mutation, {
            files: updates,
        });
        const result = data?.fileUpdate;
        const errors = (result?.userErrors || []).map((e) => e.message);
        if (errors.length > 0) {
            throw new Error(
                `Shopify file reference update failed: ${errors.join(", ")}`,
            );
        }

        return result;
    }

    async getProductMediaContext(handle, metafieldKeysString = "") {
        if (!handle) {
            throw new Error("Handle is required");
        }

        const metafieldQuery = this._buildMediaMetafieldQuery(
            metafieldKeysString,
            false,
        );
        const escapedHandle = String(handle).replace(/"/g, '\\"');

        const query = `
        {
            productByHandle(handle: "${escapedHandle}") {
                id
                title
                handle
                media(first: 100) {
                    edges {
                        node {
                            ... on MediaImage {
                                id
                                mediaContentType
                                image {
                                    originalSrc: url
                                    id
                                }
                            }
                            ... on Video {
                                id
                                mediaContentType
                            }
                            ... on Model3d {
                                id
                                mediaContentType
                            }
                            ... on ExternalVideo {
                                id
                                mediaContentType
                            }
                        }
                    }
                }
                ${metafieldQuery}
            }
        }`;

        const data = await this._request(query);
        return data?.productByHandle || null;
    }

    async _setMetafields(metafields = []) {
        if (!Array.isArray(metafields) || metafields.length === 0) return;

        const mutation = `
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
                metafields {
                    key
                    namespace
                    value
                }
                userErrors {
                    field
                    message
                }
            }
        }`;

        const data = await this._request(mutation, { metafields });
        const result = data?.metafieldsSet;
        const errors = (result?.userErrors || []).map((e) => e.message);
        if (errors.length > 0) {
            console.error(
                `[Metafields] Set failed. Payload:`,
                JSON.stringify(metafields, null, 2),
            );
            console.error(`[Metafields] Errors:`, errors);
            throw new Error(
                `Metafields set failed: ${errors.join(", ")}\n` +
                    `Payload: ${JSON.stringify(metafields)}`,
            );
        }
    }

    async _deleteMetafields(metafields = []) {
        if (!Array.isArray(metafields) || metafields.length === 0) return;

        const mutation = `
        mutation metafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
            metafieldsDelete(metafields: $metafields) {
                deletedMetafields {
                    namespace
                    key
                    ownerId
                }
                userErrors {
                    field
                    message
                }
            }
        }`;

        const data = await this._request(mutation, { metafields });
        const result = data?.metafieldsDelete;
        const errors = (result?.userErrors || []).map((e) => e.message);
        if (errors.length > 0) {
            throw new Error(`Metafields delete failed: ${errors.join(", ")}`);
        }
    }

    async detachFilesFromProduct(productId, fileIds = []) {
        if (!productId) {
            throw new Error("Missing product ID for file detach");
        }
        if (!Array.isArray(fileIds) || fileIds.length === 0) {
            throw new Error("No file IDs provided for detach");
        }

        const mutation = `
        mutation fileUpdate($files: [FileUpdateInput!]!) {
            fileUpdate(files: $files) {
                files {
                    id
                }
                userErrors {
                    field
                    message
                }
            }
        }`;

        const files = fileIds.map((id) => ({
            id,
            referencesToRemove: [productId],
        }));

        const data = await this._request(mutation, { files });
        const result = data?.fileUpdate;
        const errors = (result?.userErrors || []).map((e) => e.message);
        if (errors.length > 0) {
            throw new Error(`Shopify file detach failed: ${errors.join(", ")}`);
        }

        return result;
    }

    async removeSelectedProductImages(
        handle,
        selectedImages = [],
        metafieldKeysString = "",
    ) {
        if (!handle) {
            throw new Error("Handle is required");
        }
        if (!Array.isArray(selectedImages) || selectedImages.length === 0) {
            throw new Error("No images were selected for removal");
        }

        const product = await this.getProductMediaContext(
            handle,
            metafieldKeysString,
        );
        if (!product) {
            throw new Error(`Product not found: ${handle}`);
        }

        const selectedMediaIds = new Set(
            selectedImages.map((item) => item.mediaId).filter(Boolean),
        );
        const selectedFileIds = new Set(
            selectedImages.map((item) => item.fileId).filter(Boolean),
        );
        const selectedFilenames = new Set(
            selectedImages
                .map((item) => String(item.filename || "").toLowerCase())
                .filter(Boolean),
        );

        const normalizedFilename = (value = "") => {
            const raw =
                String(value || "")
                    .split("?")[0]
                    .split("/")
                    .pop() || "";
            return raw.toLowerCase();
        };

        const matchesSelection = (candidate = {}) => {
            const mediaId = candidate.mediaId || candidate.id || "";
            const fileId = candidate.fileId || candidate.imageId || "";
            const url = candidate.url || "";
            const remoteFilename = normalizedFilename(url);

            if (mediaId && selectedMediaIds.has(mediaId)) return true;
            if (fileId && selectedFileIds.has(fileId)) return true;
            if (!remoteFilename) return false;

            for (const filename of selectedFilenames) {
                if (
                    filename === remoteFilename ||
                    filename.endsWith(`-${remoteFilename}`)
                ) {
                    return true;
                }
            }

            return false;
        };

        const fileIdsToDetach = new Set();
        (product.media?.edges || []).forEach((edge) => {
            const node = edge?.node;
            if (!node || node.mediaContentType !== "IMAGE") return;

            if (
                matchesSelection({
                    mediaId: node.id,
                    fileId: node.image?.id,
                    url: node.image?.originalSrc,
                })
            ) {
                fileIdsToDetach.add(node.id);
            }
        });

        const parsedKeys = this._parseMetafieldKeys(metafieldKeysString);
        const metafieldsToSet = [];
        const metafieldsToDelete = [];

        parsedKeys.forEach(({ namespace, key }, index) => {
            const metafield = product[`mf_${index}`];
            if (!metafield?.type) return;

            if (metafield.type === "file_reference") {
                const reference = metafield.reference;
                if (
                    reference &&
                    matchesSelection({
                        mediaId: reference.id,
                        fileId: reference.image?.id || reference.id,
                        url:
                            reference.image?.originalSrc ||
                            reference.originalSrc ||
                            "",
                    })
                ) {
                    metafieldsToDelete.push({
                        ownerId: product.id,
                        namespace,
                        key,
                    });
                    fileIdsToDetach.add(reference.id);
                }
                return;
            }

            if (metafield.type !== "list.file_reference") return;

            const refs = (metafield.references?.edges || []).map((edge) => {
                const node = edge?.node || {};
                return {
                    id: node.id,
                    fileId: node.image?.id || node.id,
                    url: node.image?.originalSrc || node.originalSrc || "",
                };
            });

            const remaining = refs.filter((ref) => !matchesSelection(ref));
            if (remaining.length === refs.length) return;

            refs.filter((ref) => !remaining.includes(ref)).forEach((ref) =>
                fileIdsToDetach.add(ref.id),
            );

            if (remaining.length === 0) {
                metafieldsToDelete.push({
                    ownerId: product.id,
                    namespace,
                    key,
                });
                return;
            }

            metafieldsToSet.push({
                ownerId: product.id,
                namespace,
                key,
                type: metafield.type,
                value: JSON.stringify(remaining.map((ref) => ref.id)),
            });
        });

        if (
            fileIdsToDetach.size === 0 &&
            metafieldsToSet.length === 0 &&
            metafieldsToDelete.length === 0
        ) {
            throw new Error(
                "No matching Shopify images were found for the selected items",
            );
        }

        if (metafieldsToSet.length > 0) {
            await this._setMetafields(metafieldsToSet);
        }
        if (metafieldsToDelete.length > 0) {
            await this._deleteMetafields(metafieldsToDelete);
        }

        let detachResult = null;
        if (fileIdsToDetach.size > 0) {
            detachResult = await this.detachFilesFromProduct(product.id, [
                ...fileIdsToDetach,
            ]);
        }

        return {
            productId: product.id,
            detachedFileIds: [...fileIdsToDetach],
            metafieldsSet: metafieldsToSet.length,
            metafieldsDeleted: metafieldsToDelete.length,
            detachResult,
        };
    }

    async applyProductMediaLayout(
        handle,
        layout = {},
        metafieldKeysString = "",
    ) {
        if (!handle) {
            throw new Error("Handle is required");
        }

        const product = await this.getProductMediaContext(
            handle,
            metafieldKeysString,
        );
        if (!product) {
            throw new Error(`Product not found: ${handle}`);
        }

        const slots = this._getManagedMediaSlots(product, metafieldKeysString);

        // Build a map from any legacy/wrong GID variants → canonical MediaImage GID.
        // Covers: gid://shopify/ImageSource/N  →  gid://shopify/MediaImage/N
        //         raw numeric strings           →  gid://shopify/MediaImage/N
        const imageSourceToMediaImage = new Map();
        const addNodeToMap = (node) => {
            if (!node || !node.id) return;
            const mediaGid = node.id; // gid://shopify/MediaImage/N
            if (node.image?.id) {
                imageSourceToMediaImage.set(node.image.id, mediaGid);
            }
            const numericMatch = String(mediaGid).match(/(\d+)$/);
            if (numericMatch) {
                imageSourceToMediaImage.set(numericMatch[1], mediaGid);
                imageSourceToMediaImage.set(
                    `gid://shopify/ImageSource/${numericMatch[1]}`,
                    mediaGid,
                );
            }
        };

        // Index main product media
        (product.media?.edges || []).forEach((edge) => {
            const node = edge?.node;
            if (!node || node.mediaContentType !== "IMAGE") return;
            addNodeToMap(node);
        });

        // Index metafield reference images (banner/extra may not appear in main media)
        // Also map the metafield node GID itself (gid://shopify/Metafield/N) → MediaImage GID
        // to handle stale manifests that stored the metafield GID as the primary id.
        const parsedKeysForNorm = this._parseMetafieldKeys(metafieldKeysString);
        parsedKeysForNorm.forEach((_, index) => {
            const mf = product[`mf_${index}`];
            if (!mf) return;
            if (mf.reference) {
                addNodeToMap(mf.reference);
                // mf.id is gid://shopify/Metafield/N — map it to the reference MediaImage GID
                if (mf.id && mf.reference.id) {
                    imageSourceToMediaImage.set(mf.id, mf.reference.id);
                }
            }
            (mf.references?.edges || []).forEach((e) => addNodeToMap(e?.node));
        });

        const normalizeId = (id) => imageSourceToMediaImage.get(id) || id;

        console.log(`[Layout] applyProductMediaLayout: ${handle}`);
        console.log(
            `[Layout] Raw layout input:`,
            JSON.stringify(layout, null, 2),
        );
        console.log(
            `[Layout] imageSourceToMediaImage map:`,
            Object.fromEntries(imageSourceToMediaImage),
        );

        const desiredMainIds = (layout.main || [])
            .map((item) => normalizeId(item.fileId))
            .filter(Boolean);
        const desiredBannerIds = (layout.banner || [])
            .map((item) => normalizeId(item.fileId))
            .filter(Boolean);
        const desiredExtraIds = (layout.extra || [])
            .map((item) => normalizeId(item.fileId))
            .filter(Boolean);

        console.log(`[Layout] desiredMainIds (normalized):`, desiredMainIds);
        console.log(
            `[Layout] desiredBannerIds (normalized):`,
            desiredBannerIds,
        );
        console.log(`[Layout] desiredExtraIds (normalized):`, desiredExtraIds);
        console.log(`[Layout] slots:`, JSON.stringify(slots, null, 2));

        if (desiredBannerIds.length > 1) {
            throw new Error("Only one banner image can be assigned at a time");
        }

        if (desiredBannerIds.length > 0 && !slots.banner) {
            throw new Error(
                "Banner metafield is not configured. Add the banner metafield key in the dashboard first.",
            );
        }

        if (desiredExtraIds.length > 0 && !slots.extra) {
            throw new Error(
                "Extra images metafield is not configured. Add the extra-image metafield key in the dashboard first.",
            );
        }

        const currentMainIds = (product.media?.edges || [])
            .map((edge) => edge?.node)
            .filter((node) => node && node.mediaContentType === "IMAGE")
            .map((node) => node.id);

        const currentMainSet = new Set(currentMainIds);
        const desiredMainSet = new Set(desiredMainIds);

        const fileReferenceUpdates = [];
        desiredMainIds.forEach((id) => {
            if (!currentMainSet.has(id)) {
                fileReferenceUpdates.push({
                    id,
                    referencesToAdd: [product.id],
                });
            }
        });
        currentMainIds.forEach((id) => {
            if (!desiredMainSet.has(id)) {
                fileReferenceUpdates.push({
                    id,
                    referencesToRemove: [product.id],
                });
            }
        });

        const metafieldsToSet = [];
        const metafieldsToDelete = [];

        console.log(`[Layout] currentMainIds:`, currentMainIds);
        console.log(
            `[Layout] fileReferenceUpdates:`,
            JSON.stringify(fileReferenceUpdates, null, 2),
        );

        if (slots.banner) {
            if (desiredBannerIds.length === 0) {
                metafieldsToDelete.push({
                    ownerId: product.id,
                    namespace: slots.banner.namespace,
                    key: slots.banner.key,
                });
            } else {
                metafieldsToSet.push({
                    ownerId: product.id,
                    namespace: slots.banner.namespace,
                    key: slots.banner.key,
                    type: "file_reference",
                    value: desiredBannerIds[0],
                });
            }
        }

        if (slots.extra) {
            if (desiredExtraIds.length === 0) {
                metafieldsToDelete.push({
                    ownerId: product.id,
                    namespace: slots.extra.namespace,
                    key: slots.extra.key,
                });
            } else if (slots.extra.type === "file_reference") {
                if (desiredExtraIds.length > 1) {
                    throw new Error(
                        "Configured extra-image metafield only supports one file reference",
                    );
                }
                metafieldsToSet.push({
                    ownerId: product.id,
                    namespace: slots.extra.namespace,
                    key: slots.extra.key,
                    type: "file_reference",
                    value: desiredExtraIds[0],
                });
            } else {
                metafieldsToSet.push({
                    ownerId: product.id,
                    namespace: slots.extra.namespace,
                    key: slots.extra.key,
                    type: "list.file_reference",
                    value: JSON.stringify(desiredExtraIds),
                });
            }
        }

        console.log(
            `[Layout] metafieldsToSet:`,
            JSON.stringify(metafieldsToSet, null, 2),
        );
        console.log(
            `[Layout] metafieldsToDelete:`,
            JSON.stringify(metafieldsToDelete, null, 2),
        );

        const newlyAddedFileIds = new Set(
            fileReferenceUpdates
                .filter((u) => u.referencesToAdd?.length > 0)
                .map((u) => u.id),
        );

        if (fileReferenceUpdates.length > 0) {
            await this.updateFileProductReferences(fileReferenceUpdates);
        }
        if (metafieldsToSet.length > 0) {
            await this._setMetafields(metafieldsToSet);
        }
        if (metafieldsToDelete.length > 0) {
            await this._deleteMetafields(metafieldsToDelete);
        }

        let reorderResult = null;
        let mainIdsForReorder = desiredMainIds;
        if (newlyAddedFileIds.size > 0 && desiredMainIds.length >= 2) {
            // Re-fetch so newly attached files appear in product media before reordering
            const updatedProduct = await this.getProductMediaContext(
                handle,
                metafieldKeysString,
            );
            const updatedMainIds = new Set(
                (updatedProduct?.media?.edges || [])
                    .map((e) => e?.node)
                    .filter((n) => n && n.mediaContentType === "IMAGE")
                    .map((n) => n.id),
            );
            // Keep desired order but only include IDs now present in product media
            mainIdsForReorder = desiredMainIds.filter((id) =>
                updatedMainIds.has(id),
            );
        }
        if (mainIdsForReorder.length >= 2) {
            const moves = mainIdsForReorder.map((id, index) => ({
                id,
                newPosition: index,
            }));
            reorderResult = await this.reorderProductMedia(product.id, moves);
        }

        return {
            productId: product.id,
            mainCount: desiredMainIds.length,
            bannerCount: desiredBannerIds.length,
            extraCount: desiredExtraIds.length,
            reorderResult,
        };
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

        // Hardcoded custom metafields (matching CSV column order mf_0..mf_19)
        const metafieldQuery = `
                mf_0: metafield(namespace: "custom", key: "also_like") { value type }
                mf_1: metafield(namespace: "custom", key: "benefits") { value type }
                mf_2: metafield(namespace: "custom", key: "cautions") { value type }
                mf_3: metafield(namespace: "custom", key: "collection_name") { value type }
                mf_4: metafield(namespace: "custom", key: "custom_questions") { value type }
                mf_5: metafield(namespace: "custom", key: "disclaimer") { value type }
                mf_6: metafield(namespace: "custom", key: "how_to_use") { value type }
                mf_7: metafield(namespace: "custom", key: "ingredients") { value type }
                mf_8: metafield(namespace: "custom", key: "keywords") { value type }
                mf_9: metafield(namespace: "custom", key: "key_features") { value type }
                mf_10: metafield(namespace: "custom", key: "key_ingredients_benefits") { value type }
                mf_11: metafield(namespace: "custom", key: "key_message") { value type }
                mf_12: metafield(namespace: "custom", key: "materials") { value type }
                mf_13: metafield(namespace: "custom", key: "overview") { value type }
                mf_14: metafield(namespace: "custom", key: "question_answers") { value type }
                mf_15: metafield(namespace: "custom", key: "short_title") { value type }
                mf_16: metafield(namespace: "custom", key: "suitable_for_skin_type") { value type }
                mf_17: metafield(namespace: "custom", key: "user_review") { value type }
                mf_18: metafield(namespace: "custom", key: "use_it_with") { value type }
                mf_19: metafield(namespace: "custom", key: "youtube_video_links") { value type }
                metafieldGoogleProduct: metafield(namespace: "mm-google-shopping", key: "custom_product") { value type }
                metafieldFragrance: metafield(namespace: "shopify", key: "fragrance") { value }
                metafieldMoisturizerType: metafield(namespace: "shopify", key: "moisturizer-type") { value }
                metafieldProductForm: metafield(namespace: "shopify", key: "product-form") { value }
        `;

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
