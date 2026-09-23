// Test-only Typebox stub: the real module ships inside the native engine.
// Covers only the schema builders used by native Studio extensions.
const describe = (type) => (params, extra) => ({ type, params, extra });
export const Type = new Proxy(
  {},
  {
    get: (_target, prop) => {
      if (prop === 'Object') return (properties, options) => ({ type: 'object', properties, options });
      if (prop === 'Array') return (items, options) => ({ type: 'array', items, options });
      if (prop === 'Union') return (options) => ({ type: 'union', options });
      if (prop === 'Optional') return (schema) => ({ type: 'optional', schema });
      if (prop === 'Literal') return (value) => ({ type: 'literal', value });
      return describe(String(prop));
    },
  },
);
