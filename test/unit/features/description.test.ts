import * as assert from "assert";

/**
 * Mirrors the regex-only cleaning logic in
 * `src/features/hover-provider.ts`'s `cleanDescription`, duplicated here so
 * it can be unit tested without importing a module that pulls in the real
 * `vscode` package at runtime (that module also constructs live
 * `vscode.Hover`/`MarkdownString` instances, so it can only run inside the
 * Extension Host — see `test/suite/features/hover-provider.test.ts` for
 * coverage of the rest of that module's behavior).
 */
const LINKED_IMAGE_REGEX = /\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g;
const IMAGE_REGEX = /!\[[^\]]*\]\([^)]*\)/g;
const DANGLING_BADGE_TAIL_REGEX = /\s*\[?!?\[[^\]]*\]?\([^)]*$/;

function cleanDescription(description?: string): string | undefined {
  if (!description) {
    return undefined;
  }

  const cleaned = description
    .replace(LINKED_IMAGE_REGEX, "")
    .replace(IMAGE_REGEX, "")
    .replace(DANGLING_BADGE_TAIL_REGEX, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return cleaned || undefined;
}

suite("cleanDescription", () => {
  test("Returns undefined for missing or empty descriptions", () => {
    assert.equal(cleanDescription(undefined), undefined);
    assert.equal(cleanDescription(""), undefined);
  });

  test("Passes through a plain description unchanged", () => {
    assert.equal(
      cleanDescription("A simple, honest description."),
      "A simple, honest description.",
    );
  });

  test("Keeps prose with real markdown links/bold intact (@ai-sdk/openai)", () => {
    const description =
      "The **[OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai)** for the [AI SDK](https://ai-sdk.dev/docs) contains language model support for the OpenAI chat and completion APIs and embedding model support for the OpenAI embeddings API.";

    assert.equal(cleanDescription(description), description);
  });

  test("Strips a truncated shields.io badge chain down to nothing (@aws-sdk/s3-request-presigner)", () => {
    const description =
      "[![NPM version](https://img.shields.io/npm/v/@aws-sdk/s3-request-presigner/latest.svg)](https://www.npmjs.com/package/@aws-sdk/s3-request-presigner) [![NPM downloads](https://img.shields.io/npm/dm/@aws-sdk/s3-request-presigner.svg)](https://www.npmjs.com/";

    assert.equal(cleanDescription(description), undefined);
  });

  test("Strips a leading badge and keeps the real text that follows", () => {
    assert.equal(
      cleanDescription(
        "![build](https://ci.example.com/badge.svg) Real description here.",
      ),
      "Real description here.",
    );
  });

  test("Strips a complete linked-image badge with no truncation", () => {
    assert.equal(
      cleanDescription(
        "[![CI](https://img.shields.io/badge/ci-passing-green)](https://ci.example.com) A tested library.",
      ),
      "A tested library.",
    );
  });
});
