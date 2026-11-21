/** Work around Google Gemini App ProcessQuery stalling on the standalone word "sheet".
 * Inserts a zero-width space between "she" and "et" in prompt text and descriptions,
 * while leaving tool names, parameter property keys, tool call IDs, and image URLs intact.
 */
export const SHEET_TRIGGER_RE = /\b(she)(et)\b/gi;
const REPLACEMENT = '$1\u200b$2';

export function cloakText(value) {
  if (typeof value !== 'string' || value.length < 5) return value;
  return value.replace(SHEET_TRIGGER_RE, REPLACEMENT);
}

export function cloakSchemaDescriptions(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 16) return;
  if (Array.isArray(schema)) {
    for (let i = 0; i < schema.length; i++) {
      cloakSchemaDescriptions(schema[i], depth + 1);
    }
    return;
  }
  if (typeof schema.description === 'string') {
    schema.description = cloakText(schema.description);
  }
  if (typeof schema.title === 'string') {
    schema.title = cloakText(schema.title);
  }
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    for (const child of Object.values(schema.properties)) {
      cloakSchemaDescriptions(child, depth + 1);
    }
  }
  if (schema.$defs && typeof schema.$defs === 'object' && !Array.isArray(schema.$defs)) {
    for (const child of Object.values(schema.$defs)) {
      cloakSchemaDescriptions(child, depth + 1);
    }
  }
  if (schema.definitions && typeof schema.definitions === 'object' && !Array.isArray(schema.definitions)) {
    for (const child of Object.values(schema.definitions)) {
      cloakSchemaDescriptions(child, depth + 1);
    }
  }
  if (schema.patternProperties && typeof schema.patternProperties === 'object' && !Array.isArray(schema.patternProperties)) {
    for (const child of Object.values(schema.patternProperties)) {
      cloakSchemaDescriptions(child, depth + 1);
    }
  }
  if (schema.items) cloakSchemaDescriptions(schema.items, depth + 1);
  if (schema.additionalItems) cloakSchemaDescriptions(schema.additionalItems, depth + 1);
  if (schema.prefixItems) cloakSchemaDescriptions(schema.prefixItems, depth + 1);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    cloakSchemaDescriptions(schema.additionalProperties, depth + 1);
  }
  if (schema.not) cloakSchemaDescriptions(schema.not, depth + 1);
  if (schema.anyOf) cloakSchemaDescriptions(schema.anyOf, depth + 1);
  if (schema.oneOf) cloakSchemaDescriptions(schema.oneOf, depth + 1);
  if (schema.allOf) cloakSchemaDescriptions(schema.allOf, depth + 1);
}

function cloakMessageContent(content) {
  if (typeof content === 'string') return cloakText(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!part || typeof part !== 'object') return part;
    if (part.type === 'text' && typeof part.text === 'string') {
      return { ...part, text: cloakText(part.text) };
    }
    return part;
  });
}

export function cloakChatBody(body) {
  if (!body || typeof body !== 'object') return body;
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.content !== undefined && msg.content !== null) {
        msg.content = cloakMessageContent(msg.content);
      }
    }
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object') continue;
      const fn = tool.function ?? tool;
      if (!fn || typeof fn !== 'object') continue;
      if (typeof fn.description === 'string') {
        fn.description = cloakText(fn.description);
      }
      if (fn.parameters && typeof fn.parameters === 'object') {
        cloakSchemaDescriptions(fn.parameters, 0);
      }
    }
  }
  if (body.response_format?.type === 'json_schema' && body.response_format.json_schema) {
    const spec = body.response_format.json_schema;
    if (typeof spec.description === 'string') {
      spec.description = cloakText(spec.description);
    }
    if (spec.schema && typeof spec.schema === 'object') {
      cloakSchemaDescriptions(spec.schema, 0);
    }
  }
  return body;
}

export function cloakResponsesBody(body) {
  if (!body || typeof body !== 'object') return body;
  if (typeof body.instructions === 'string') {
    body.instructions = cloakText(body.instructions);
  }
  if (typeof body.input === 'string') {
    body.input = cloakText(body.input);
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.text === 'string') item.text = cloakText(item.text);
      if (typeof item.output === 'string') item.output = cloakText(item.output);
      if (item.content !== undefined) {
        item.content = cloakMessageContent(item.content);
      }
    }
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object') continue;
      if (typeof tool.description === 'string') tool.description = cloakText(tool.description);
      if (tool.parameters && typeof tool.parameters === 'object') {
        cloakSchemaDescriptions(tool.parameters, 0);
      }
      if (Array.isArray(tool.tools)) {
        for (const sub of tool.tools) {
          if (!sub || typeof sub !== 'object') continue;
          if (typeof sub.description === 'string') sub.description = cloakText(sub.description);
          if (sub.parameters && typeof sub.parameters === 'object') {
            cloakSchemaDescriptions(sub.parameters, 0);
          }
        }
      }
    }
  }
  return body;
}
