/**
 * Paseo supplies runtime entries at runtime and paseo-plugin.d.ts
 * supplies their types. Vitest aliases specifiers here.
 */

export function defineRpc<Definition>(definition: Definition): Definition {
  return definition;
}

export function defineAttachmentSource<Definition>(definition: Definition): Definition {
  return definition;
}

export function defineSettings<Definition>(definition: Definition): Definition {
  return definition;
}
