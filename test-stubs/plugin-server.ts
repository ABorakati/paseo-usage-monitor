/**
 * Paseo supplies `@getpaseo/plugin/server` at runtime and `paseo-plugin.d.ts`
 * supplies its types, so nothing installs it. Tests import the shared contracts,
 * which call `defineRpc`, so vitest aliases the specifier here.
 */

export function defineRpc<Definition>(definition: Definition): Definition {
  return definition;
}

export function defineAttachmentSource<Definition>(definition: Definition): Definition {
  return definition;
}
