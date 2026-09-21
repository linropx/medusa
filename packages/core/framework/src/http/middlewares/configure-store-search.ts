import { SearchTypes } from "@medusajs/types"
import { NextFunction, RequestHandler } from "express"
import { MedusaRequest, MedusaResponse } from "../types"

/**
 * What a store allows on one of its search indexes.
 */
export type StoreSearchIndexConfig = {
  /**
   * Filters ANDed onto every query for this index, on top of whatever the
   * caller sent, so a storefront can narrow its own results but never widen
   * past these.
   */
  filters?: SearchTypes.SearchFilters
}

export type StoreSearchConfig = {
  /**
   * The indexes `POST /store/search` may query, keyed by index name. `true`
   * exposes an index as is, and an object exposes it under the constraints it
   * carries. Anything absent, or set to `false`, is not searchable.
   */
  allowed_indexes: Record<string, boolean | StoreSearchIndexConfig>
}

/**
 * What {@link configureStoreSearch} adds to the request. Intersected into the
 * one route that reads it rather than carried by every `MedusaRequest`.
 */
export type ConfiguredStoreSearch = {
  storeSearchConfig?: StoreSearchConfig
}

/**
 * Creates a middleware that configures `POST /store/search`.
 *
 * Nothing is searchable there until this opts an index in, and the config is
 * never taken from the request: what a storefront may reach is the store's to
 * decide. Several middlewares can each contribute, so a plugin can expose its
 * own index without discarding what the app configured; the last one to name a
 * given index wins.
 *
 * A product index that declares a filterable `sales_channel_ids` is scoped to
 * the publishable key's sales channels by the route itself, so `filters` is for
 * whatever a store wants on top of that.
 *
 * @param config - The indexes to expose and the constraints to apply to them.
 *
 * @example
 * import { configureStoreSearch, defineMiddlewares } from "@medusajs/framework/http"
 *
 * export default defineMiddlewares({
 *   routes: [
 *     {
 *       matcher: "/store/search",
 *       middlewares: [
 *         configureStoreSearch({
 *           allowed_indexes: {
 *             product: { filters: { status: "published" } },
 *             product_category: true,
 *           },
 *         }),
 *       ],
 *     },
 *   ],
 * })
 */
export const configureStoreSearch = (
  config: StoreSearchConfig
): RequestHandler => {
  return ((
    req: MedusaRequest & ConfiguredStoreSearch,
    _res: MedusaResponse,
    next: NextFunction
  ): void => {
    req.storeSearchConfig = {
      allowed_indexes: {
        ...(req.storeSearchConfig?.allowed_indexes ?? {}),
        ...config.allowed_indexes,
      },
    }

    next()
  }) as unknown as RequestHandler
}
