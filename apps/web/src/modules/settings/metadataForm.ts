import { METADATA_KEY_MAX } from "./metadataTypes";

/**
 * Keys travel in a header and are stored as an opaque string. The server
 * rejects anything else, so the form does the same before sending it.
 */
export function validateMetadataKey(value: string): string {
  if (!value) return "Enter a key, or leave the field blank to keep the saved key.";
  if (value.length > METADATA_KEY_MAX) return `The key must be ${METADATA_KEY_MAX} characters or fewer.`;
  if (!/^[\x21-\x7E]+$/.test(value)) {
    return "The key can only use printable ASCII characters, without spaces.";
  }
  return "";
}
