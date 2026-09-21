---
"@medusajs/medusa": patch
"@medusajs/types": patch
"@medusajs/framework": patch
---

feat(medusa,types,framework): add a generic, InstantSearch-compatible store search endpoint

`POST /store/search` takes the `SearchQuery` batch `@medusajs/instantsearch-adapter`
sends, runs each query against the index it names, and answers with the search
engine's own results — hits, scores, highlights and facets. It replaces
`/store/products/search`, whose `GET` shape neither InstantSearch nor the adapter
could talk to.

Nothing is searchable until a store opts an index in with the new
`configureStoreSearch` middleware, which is also where it narrows what a query
may reach within an allowed index. A product index that flattens its sales
channels into a filterable `sales_channel_ids` is scoped to the publishable
key's channels automatically, as every other store product read is.
