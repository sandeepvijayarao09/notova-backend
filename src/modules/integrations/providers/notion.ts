import type { Env } from '../../../config/env.js';
import { badRequest, internal } from '../../../lib/errors.js';
import type { IntegrationExport, IntegrationExportResult } from '../../../lib/types.js';
import type { OAuthProvider } from './index.js';

const NOTION_VERSION = '2022-06-28';

/**
 * Notion integration. Implements a real "create a page" export. Notion uses
 * OAuth2 authorization code (no PKCE) with HTTP Basic auth for the token
 * exchange. The export creates a page in a database or under a parent page id
 * supplied via the connection metadata (`databaseId` or `pageId`).
 *
 * This function performs a live network call and is therefore never exercised
 * by the test suite.
 */
export const notion: OAuthProvider = {
  id: 'notion',
  label: 'Notion',
  scopes: [],
  usesPkce: false,
  authorizeEndpoint: () => 'https://api.notion.com/v1/oauth/authorize',
  tokenEndpoint: () => 'https://api.notion.com/v1/oauth/token',
  extraAuthorizeParams: () => ({ owner: 'user' }),
  credentials(env: Env) {
    if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) return undefined;
    return { clientId: env.NOTION_CLIENT_ID, clientSecret: env.NOTION_CLIENT_SECRET };
  },

  async export(connection, payload): Promise<IntegrationExportResult> {
    const meta = connection.metadata ?? {};
    const databaseId = typeof meta.databaseId === 'string' ? meta.databaseId : undefined;
    const pageId = typeof meta.pageId === 'string' ? meta.pageId : undefined;

    const parent = databaseId
      ? { type: 'database_id', database_id: databaseId }
      : pageId
        ? { type: 'page_id', page_id: pageId }
        : undefined;

    if (!parent) {
      throw badRequest(
        'Notion export requires a parent: store `databaseId` or `pageId` in the connection metadata.'
      );
    }

    const body = {
      parent,
      properties: buildProperties(parent.type, payload),
      children: buildBlocks(payload),
    };

    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw internal(`Notion API error (${res.status}): ${text.slice(0, 500)}`);
    }

    const json = (await res.json()) as { id?: string; url?: string };
    return {
      externalId: json.id ?? '',
      url: json.url ?? null,
      status: 'exported',
    };
  },
};

function buildProperties(parentType: string, payload: IntegrationExport): Record<string, unknown> {
  const title = payload.recording.title || 'Notova Recording';
  // Database pages key the title by the database's title property name, which
  // we cannot know generically — Notion accepts "title" for many setups; for a
  // page parent, the title property is always named "title".
  if (parentType === 'database_id') {
    return { Name: { title: [{ text: { content: title } }] } };
  }
  return { title: { title: [{ text: { content: title } }] } };
}

function buildBlocks(payload: IntegrationExport): unknown[] {
  const blocks: unknown[] = [];

  blocks.push(heading('Summary'));
  if (payload.summary.text) {
    blocks.push(paragraph(payload.summary.text));
  }
  for (const bullet of payload.summary.bullets ?? []) {
    blocks.push(bulletedItem(bullet));
  }

  const actionItems = payload.summary.actionItems ?? [];
  if (actionItems.length > 0) {
    blocks.push(heading('Action Items'));
    for (const item of actionItems) {
      blocks.push(todoItem(item.text, item.done));
    }
  }

  blocks.push(heading('Transcript'));
  // Notion limits text content to 2000 chars per rich-text object; chunk it.
  for (const chunk of chunkString(payload.transcript.text, 1900)) {
    blocks.push(paragraph(chunk));
  }

  return blocks;
}

function heading(text: string) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function paragraph(text: string) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function bulletedItem(text: string) {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function todoItem(text: string, checked: boolean) {
  return {
    object: 'block',
    type: 'to_do',
    to_do: { rich_text: [{ type: 'text', text: { content: text } }], checked },
  };
}

function chunkString(value: string, size: number): string[] {
  if (!value) return [''];
  const out: string[] = [];
  for (let i = 0; i < value.length; i += size) {
    out.push(value.slice(i, i + size));
  }
  return out;
}
