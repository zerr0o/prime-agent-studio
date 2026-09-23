// Test-only resolver: map bare 'typebox' to the local stub so native
// extension modules load outside the engine during unit tests.
export async function resolve(specifier, context, next) {
  if (specifier === 'typebox')
    return { url: new URL('./typebox-stub.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
