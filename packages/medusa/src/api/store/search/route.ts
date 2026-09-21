import {
  ConfiguredStoreSearch,
  MedusaResponse,
  MedusaStoreRequest,
} from "@medusajs/framework/http"
import { HttpTypes, Logger, SearchTypes } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
  isPresent,
} from "@medusajs/framework/utils"

const PRODUCT_ENTITY = "product"

/**
 * The field a product index is expected to flatten its sales channels into, as
 * `sales_channels.id` is a relation rather than something an engine can filter.
 */
const SALES_CHANNEL_FIELD = "sales_channel_ids"

/**
 * Warned once per index: a definition cannot change under a running process, so
 * repeating it on every search would only be noise.
 */
const unscopedProductIndexes = new Set<string>()

/**
 * Answers with the engine's own results — hits, scores, highlights, facets —
 * which is the contract InstantSearch's search client is built on. Each query
 * names its index, and a batch resolves in one round-trip.
 *
 * Nothing is searchable until a middleware opts an index in with
 * `configureStoreSearch`, which is also where a store narrows what a query may
 * reach within an allowed index.
 */
export const POST = async (
  req: MedusaStoreRequest<HttpTypes.StoreSearch> & ConfiguredStoreSearch,
  res: MedusaResponse<HttpTypes.StoreSearchResponse>
) => {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const searchModule = req.scope.resolve(Modules.SEARCH, {
    allowUnregistered: true,
  })

  if (!searchModule) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "The Search Module is not installed, so nothing can be searched."
    )
  }

  const allowed = req.storeSearchConfig?.allowed_indexes ?? {}

  const body = req.validatedBody
  const queries = "queries" in body ? body.queries : [body]

  const plans = queries.map(({ entity, fields }) => {
    const config = allowed[entity]

    // Answered exactly like an index that doesn't exist, so the endpoint never
    // tells a client what the store holds.
    if (!config) {
      logger.warn(
        `Search index "${entity}" is not exposed on /store/search. Opt it in with the \`configureStoreSearch\` middleware.`
      )

      throw notFound(entity)
    }

    let index: SearchTypes.ResolvedSearchIndexDefinition
    try {
      index = searchModule.getIndex(entity)
    } catch {
      // The module's own message names every registered index.
      throw notFound(entity)
    }

    const retrievable = new Set(searchModule.listRetrievableFields(entity))

    return {
      primaryKey: index.primary_key,
      salesChannelFilter: buildSalesChannelFilter(index, req, logger),
      filters: config === true ? undefined : config.filters,
      // Left unset, `fields` defaults to the index' own, so nothing to hydrate.
      withHydration: !!fields?.some((field) => !retrievable.has(field)),
    }
  })

  // `locale` only reaches the hydration — what the index returns is whatever
  // the seed wrote.
  const results = await query.search(
    queries.map((searchQuery, i) => ({
      ...searchQuery,
      // Requested last, so its `q` wins over anything the store configured.
      filters: mergeSearchFilters(
        plans[i].salesChannelFilter,
        plans[i].filters,
        searchQuery.filters
      ),
    })),
    { locale: req.locale }
  )

  res.json({
    results: results.map(({ data, search_result: searchResult }, i) => {
      const { primaryKey, withHydration } = plans[i]

      if (!withHydration) {
        return searchResult
      }

      const hydrated = new Map(data.map((entry) => [entry[primaryKey], entry]))

      return {
        ...searchResult,
        hits: searchResult.hits.map((hit) => ({
          ...hit,
          document: hydrated.get(hit.id) ?? hit.document,
        })),
      }
    }),
  })
}

const notFound = (entity: string) =>
  new MedusaError(
    MedusaError.Types.NOT_FOUND,
    `No search index named "${entity}"`
  )

/**
 * Scopes a product index to the sales channels the publishable key is bound to,
 * which is what `/store/products` does for every other product read. Applied
 * only when the index declares the field as filterable — an index that shapes
 * its sales channels differently is left to the middleware's own `filters`.
 */
function buildSalesChannelFilter(
  index: SearchTypes.ResolvedSearchIndexDefinition,
  req: MedusaStoreRequest,
  logger: Logger
): SearchTypes.SearchFilters | undefined {
  if (index.entity !== PRODUCT_ENTITY) {
    return undefined
  }

  if (index.fields[SALES_CHANNEL_FIELD]?.filterable !== true) {
    if (!unscopedProductIndexes.has(index.name)) {
      unscopedProductIndexes.add(index.name)

      logger.warn(
        `Search index "${index.name}" holds products but declares no filterable "${SALES_CHANNEL_FIELD}", so /store/search serves it across every sales channel. Add the field to the index, or scope it through the \`filters\` of \`configureStoreSearch\`.`
      )
    }

    return undefined
  }

  const salesChannelIds = req.publishable_key_context.sales_channel_ids

  if (!salesChannelIds.length) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Publishable key needs to have a sales channel configured`
    )
  }

  return { [SALES_CHANNEL_FIELD]: salesChannelIds }
}

/**
 * ANDs the filters together, so a query can narrow its own results but never
 * widen past what the endpoint and the store allow. `q` stays at the top level,
 * which is where the Search Module lifts it out of, and the last one given wins.
 */
function mergeSearchFilters(
  ...filters: (SearchTypes.SearchFilters | undefined)[]
): SearchTypes.SearchFilters | undefined {
  const present = filters.filter(isPresent) as SearchTypes.SearchFilters[]

  if (present.length < 2) {
    return present[0]
  }

  let q: string | undefined
  const branches: SearchTypes.SearchFilters[] = []

  for (const filter of present) {
    const { q: filterQuery, ...rest } = filter

    if (filterQuery !== undefined) {
      q = filterQuery
    }
    if (isPresent(rest)) {
      branches.push(rest)
    }
  }

  return {
    ...(isPresent(q) ? { q } : {}),
    ...(branches.length > 1 ? { $and: branches } : branches[0] ?? {}),
  }
}
