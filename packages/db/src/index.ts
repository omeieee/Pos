// `seed` is deliberately not re-exported: it holds the owner's test PromptPay ID, and the
// production bundle must never contain it. Import it from `@sds/db/seed` (tests, local dev).
export * from './client.ts';
export * as schema from './schema.ts';
