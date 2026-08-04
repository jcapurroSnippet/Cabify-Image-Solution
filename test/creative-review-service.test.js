import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  createReviewBatch,
  exchangeReviewToken,
  finalizeReviewBatch,
  getPublicReviewBatch,
  getReviewBatch,
  importLegacyReviewBatch,
  issueReviewLink,
  registerReviewItems,
  resetCreativeReviewServiceDependenciesForTest,
  retryReviewPublication,
  revokeReviewBatch,
  saveReviewDecisions,
  setCreativeReviewServiceDependenciesForTest,
} from '../server/services/creativeReviewService.js';

const columnIndex = (letters) => {
  let value = 0;
  for (const letter of String(letters || '').toUpperCase()) value = value * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, value - 1);
};

const parseRange = (range) => {
  const bang = String(range).lastIndexOf('!');
  const rawSheet = String(range).slice(0, bang);
  const sheetName = rawSheet.startsWith("'")
    ? rawSheet.slice(1, -1).replaceAll("''", "'")
    : rawSheet;
  const address = String(range).slice(bang + 1);
  const match = address.match(/^([A-Z]+)(\d+)?(?::([A-Z]+)?(\d+)?)?$/i);
  if (!match) throw new Error(`Unsupported fake Sheet range: ${range}`);
  return {
    sheetName,
    startColumn: columnIndex(match[1]),
    startRow: match[2] ? Number(match[2]) - 1 : 0,
    endColumn: match[3] ? columnIndex(match[3]) : columnIndex(match[1]),
    endRow: match[4] ? Number(match[4]) - 1 : null,
  };
};

const trimValues = (rows) => {
  const normalized = rows.map((row) => {
    const copy = [...row];
    while (copy.length && (copy.at(-1) === '' || copy.at(-1) === undefined || copy.at(-1) === null)) copy.pop();
    return copy;
  });
  while (normalized.length && normalized.at(-1).length === 0) normalized.pop();
  return normalized;
};

const primitiveCell = (value) => ({
  userEnteredValue: typeof value === 'number' ? { numberValue: value } : { stringValue: String(value || '') },
  formattedValue: String(value || ''),
});

const createFakeGoogleWorkspace = ({ sourceRows, sourceGridRows, driveImages = {} } = {}) => {
  let nextSheetId = 10;
  let nextUploadId = 1;
  let nextBackupId = 1;
  const operations = [];
  const tables = new Map();

  const addTable = (title, rows = [], gridRows = null, columnCount = Math.max(8, rows[0]?.length || 0)) => {
    const table = {
      id: nextSheetId++,
      title,
      rows: rows.map((row) => [...row]),
      gridRows,
      rowCount: Math.max(100, rows.length + 20),
      columnCount,
      notes: new Map(),
      formats: new Map(),
    };
    tables.set(title, table);
    return table;
  };

  addTable('RIDERS | AR', sourceRows || [
    ['Category', 'Plaza', 'Reference', '1:1', '9:16', '16:9'],
    ['Generic', 'AR', '', '', '', ''],
    ['Generic', 'AR', '', '', '', ''],
  ], sourceGridRows || null, 6);

  const getTable = (title) => {
    const table = tables.get(title);
    if (!table) {
      const error = new Error(`Sheet ${title} not found`);
      error.code = 404;
      throw error;
    }
    return table;
  };

  const writeValues = (range, values) => {
    const parsed = parseRange(range);
    const table = getTable(parsed.sheetName);
    values.forEach((row, rowOffset) => {
      const rowIndex = parsed.startRow + rowOffset;
      table.rows[rowIndex] ||= [];
      row.forEach((value, columnOffset) => {
        table.rows[rowIndex][parsed.startColumn + columnOffset] = value;
      });
    });
  };

  const valuesApi = {
    get: async ({ range }) => {
      const parsed = parseRange(range);
      const table = getTable(parsed.sheetName);
      const finalRow = parsed.endRow ?? Math.max(0, table.rows.length - 1);
      const rows = [];
      for (let rowIndex = parsed.startRow; rowIndex <= finalRow; rowIndex += 1) {
        const source = table.rows[rowIndex] || [];
        rows.push(source.slice(parsed.startColumn, parsed.endColumn + 1));
      }
      return { data: { values: trimValues(rows) } };
    },
    update: async ({ range, requestBody }) => {
      operations.push({ type: 'values.update', range });
      writeValues(range, requestBody?.values || []);
      return { data: {} };
    },
    append: async ({ range, requestBody }) => {
      operations.push({ type: 'values.append', range });
      const { sheetName } = parseRange(range);
      const table = getTable(sheetName);
      for (const row of requestBody?.values || []) table.rows.push([...row]);
      return { data: {} };
    },
    batchUpdate: async ({ requestBody }) => {
      operations.push({ type: 'values.batchUpdate' });
      for (const entry of requestBody?.data || []) writeValues(entry.range, entry.values || []);
      return { data: {} };
    },
  };

  const sheets = {
    spreadsheets: {
      get: async ({ includeGridData = false, ranges = [] } = {}) => {
        if (!includeGridData) {
          return {
            data: {
              sheets: [...tables.values()].map((table) => ({
                properties: {
                  sheetId: table.id,
                  title: table.title,
                  gridProperties: { rowCount: table.rowCount, columnCount: table.columnCount },
                },
              })),
            },
          };
        }
        const { sheetName } = parseRange(ranges[0]);
        const table = getTable(sheetName);
        const rowData = table.gridRows || table.rows.map((row) => ({ values: row.map(primitiveCell) }));
        return {
          data: {
            sheets: [{
              properties: {
                sheetId: table.id,
                title: table.title,
                gridProperties: { rowCount: table.rowCount, columnCount: table.columnCount },
              },
              data: [{ rowData }],
            }],
          },
        };
      },
      batchUpdate: async ({ requestBody }) => {
        for (const request of requestBody?.requests || []) {
          if (request.addSheet) {
            operations.push({ type: 'addSheet', title: request.addSheet.properties.title });
            addTable(
              request.addSheet.properties.title,
              [],
              null,
              request.addSheet.properties.gridProperties?.columnCount || 40,
            );
          } else if (request.appendDimension) {
            const table = [...tables.values()].find((entry) => entry.id === request.appendDimension.sheetId);
            table.columnCount += request.appendDimension.length;
            operations.push({ type: 'appendDimension', title: table.title });
          } else if (request.repeatCell) {
            const table = [...tables.values()].find((entry) => entry.id === request.repeatCell.range.sheetId);
            const key = `${request.repeatCell.range.startRowIndex}:${request.repeatCell.range.startColumnIndex}`;
            table.formats.set(key, request.repeatCell.cell?.userEnteredFormat?.backgroundColorStyle?.rgbColor || null);
          } else if (request.updateCells) {
            const table = [...tables.values()].find((entry) => entry.id === request.updateCells.range.sheetId);
            const key = `${request.updateCells.range.startRowIndex}:${request.updateCells.range.startColumnIndex}`;
            table.notes.set(key, request.updateCells.rows?.[0]?.values?.[0]?.note || '');
          }
        }
        return { data: {} };
      },
      values: valuesApi,
    },
  };

  const drive = {
    files: {
      copy: async (request = {}) => {
        operations.push({
          type: 'drive.copy',
          fileId: request.fileId,
          parents: request.requestBody?.parents || [],
        });
        const id = `backup-${nextBackupId++}`;
        return { data: { id, name: id, webViewLink: `https://docs.google.com/spreadsheets/d/${id}/edit` } };
      },
      get: async ({ fileId, alt }) => {
        const buffer = driveImages[fileId];
        if (!buffer) throw new Error(`Drive image ${fileId} not found`);
        return alt === 'media'
          ? { data: buffer }
          : { data: { mimeType: 'image/png' } };
      },
    },
  };

  return {
    sheets,
    drive,
    operations,
    tables,
    dependencies: {
      getSheetsClient: async () => sheets,
      getDriveClient: async () => drive,
      findOrCreateDriveFolder: async (name, parentFolderId) => {
        operations.push({ type: 'drive.folder', name, parentFolderId });
        return { folderId: `folder-${name}` };
      },
      uploadBufferToDrive: async () => {
        operations.push({ type: 'drive.upload' });
        return { fileId: `review-upload-${nextUploadId++}` };
      },
      listCreativeLibrary: async () => ({ creatives: [] }),
    },
    patchReviewRow(batchId, field, value) {
      const table = getTable('creative_review_batches');
      const headerIndex = table.rows[0].indexOf(field);
      const row = table.rows.find((candidate) => candidate[0] === batchId);
      row[headerIndex] = value;
    },
  };
};

const imageDataUrl = async (width, height, color = '#663399') => {
  const buffer = await sharp({
    create: { width, height, channels: 4, background: color },
  }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString('base64')}`;
};

test('service flow isolates tokens, supersedes real regenerations and retries only failed approved publications', async () => {
  const workspace = createFakeGoogleWorkspace();
  const publishedKeys = new Set();
  const publicationCalls = [];
  let failPortraitOnce = true;
  setCreativeReviewServiceDependenciesForTest({
    ...workspace.dependencies,
    ingestApprovedReviewCreative: async ({ item }) => {
      publicationCalls.push(item.review_item_id);
      if (item.aspect_ratio === '9:16' && failPortraitOnce) {
        failPortraitOnce = false;
        throw new Error('temporary library failure');
      }
      const key = `${item.review_item_id}:${item.image_hash}`;
      const status = publishedKeys.has(key) ? 'already_stored' : 'stored';
      publishedKeys.add(key);
      return { status, creativeId: `library-${item.review_item_id}`, imageHash: item.image_hash };
    },
  });

  try {
    const sheetsUrl = 'https://docs.google.com/spreadsheets/d/sheet_integration/edit';
    const batch = await createReviewBatch({
      sheetsUrl,
      title: 'Client review',
      sourceType: 'batch_sheets',
      createdBy: 'Studio User',
      category: 'Generic',
      plazas: 'AR',
      sourceTab: 'RIDERS | AR',
      metadata: { expectedItemCount: 3 },
    });
    const square = await imageDataUrl(100, 100);
    const portrait = await imageDataUrl(90, 160, '#aa3377');
    const landscape = await imageDataUrl(160, 90, '#22aa88');
    const registered = await registerReviewItems({
      sheetsUrl,
      batchId: batch.batchId,
      items: [
        { itemId: 'item-square', generationId: 'run-1-square', familyId: 'family-1', ratio: '1:1', variantIndex: 1, imageUrl: square, category: 'Generic', plazas: 'AR', sourceTab: 'RIDERS | AR', sourceRowNumber: 2, sourceCell: 'D2' },
        { itemId: 'item-portrait', generationId: 'run-1-portrait', familyId: 'family-1', ratio: '9:16', variantIndex: 1, imageUrl: portrait, category: 'Generic', plazas: 'AR', sourceTab: 'RIDERS | AR', sourceRowNumber: 2, sourceCell: 'E2' },
        { itemId: 'item-landscape', generationId: 'run-1-landscape', familyId: 'family-1', ratio: '16:9', variantIndex: 1, imageUrl: landscape, category: 'Generic', plazas: 'AR', sourceTab: 'RIDERS | AR', sourceRowNumber: 2, sourceCell: 'F2' },
      ],
    });
    assert.equal(registered.items.length, 3);
    assert.equal(registered.items.every((item) => item.decision === 'pending'), true);

    const link = await issueReviewLink({ sheetsUrl, batchId: batch.batchId, baseUrl: 'https://review.example' });
    assert.match(link.privateUrl, /^https:\/\/review\.example\/review#token=/);
    assert.equal(link.privateUrl.includes('?token='), false);
    await exchangeReviewToken({ token: link.token });
    assert.equal((await getPublicReviewBatch({ token: link.token })).review_batch_id, batch.batchId);

    const other = await createReviewBatch({
      sheetsUrl,
      title: 'Other client review',
      sourceType: 'editor_batch',
      category: 'Generic',
      plazas: 'AR',
      metadata: { expectedItemCount: 1 },
    });
    await registerReviewItems({
      sheetsUrl,
      batchId: other.batchId,
      items: [{ itemId: 'other-item', generationId: 'other-run-1', familyId: 'other-family', variantIndex: 1, imageUrl: square, category: 'Generic', plazas: 'AR', sourceOutput: `editor_batch:${other.batchId}:1` }],
    });
    const otherLink = await issueReviewLink({ sheetsUrl, batchId: other.batchId, baseUrl: 'https://review.example' });
    assert.equal((await getPublicReviewBatch({ token: otherLink.token })).review_batch_id, other.batchId);
    await assert.rejects(
      () => saveReviewDecisions({ token: link.token, decisions: [{ reviewItemId: 'other-item', status: 'approved', expectedVersion: 1 }] }),
      (error) => error.code === 'REVIEW_ITEM_NOT_FOUND',
    );

    await saveReviewDecisions({
      token: link.token,
      decisions: [
        { reviewItemId: 'item-square', status: 'approved', expectedVersion: 1 },
        { reviewItemId: 'item-portrait', status: 'approved', expectedVersion: 1 },
        { reviewItemId: 'item-landscape', status: 'rejected', reason: 'CTA is clipped', expectedVersion: 1 },
      ],
    });
    const retrySave = await saveReviewDecisions({
      token: link.token,
      decisions: [
        { reviewItemId: 'item-square', status: 'approved', expectedVersion: 1 },
        { reviewItemId: 'item-portrait', status: 'approved', expectedVersion: 1 },
        { reviewItemId: 'item-landscape', status: 'rejected', reason: 'CTA is clipped', expectedVersion: 1 },
      ],
    });
    assert.deepEqual(retrySave.items.map((item) => item.version), [2, 2, 2]);
    const source = workspace.tables.get('RIDERS | AR');
    assert.match(source.rows[1][6], /CTA is clipped/);
    assert.equal(source.formats.get('1:3').green > 0.9, true);
    assert.equal(source.formats.get('1:5').red > 0.9, true);

    const firstPublication = await finalizeReviewBatch({
      token: link.token,
      reviewerName: 'Client Reviewer',
      reviewerEmail: 'client@example.com',
    });
    assert.equal(firstPublication.batch.status, 'publish_failed');
    assert.equal(firstPublication.publication.some((entry) => entry.itemId === 'item-landscape'), false);
    assert.equal(publishedKeys.size, 1);

    const repaired = await retryReviewPublication({ sheetsUrl, batchId: batch.batchId });
    assert.equal(repaired.batch.status, 'published');
    assert.deepEqual(publicationCalls, ['item-square', 'item-portrait', 'item-portrait']);
    assert.equal(publishedKeys.size, 2);
    assert.equal(repaired.items.find((item) => item.review_item_id === 'item-landscape').publication_status, 'not_published');
    assert.equal(repaired.items.every((item) => item.decision === 'rejected' || item.reviewer_email === 'client@example.com'), true);

    await saveReviewDecisions({
      token: otherLink.token,
      decisions: [{ reviewItemId: 'other-item', status: 'approved', expectedVersion: 1 }],
    });
    const regeneration = await registerReviewItems({
      sheetsUrl,
      batchId: other.batchId,
      items: [{ itemId: 'other-item-v2', generationId: 'other-run-2', familyId: 'other-family', variantIndex: 1, imageUrl: square, category: 'Generic', plazas: 'AR', sourceOutput: `editor_batch:${other.batchId}:1` }],
    });
    assert.equal(regeneration.items[0].decision, 'pending');
    assert.equal(regeneration.items[0].creative_version, 2);
    const otherState = await getReviewBatch({ sheetsUrl, batchId: other.batchId });
    assert.equal(otherState.items.find((item) => item.review_item_id === 'other-item').decision, 'superseded');

    workspace.patchReviewRow(other.batchId, 'expires_at', '2000-01-01T00:00:00.000Z');
    await assert.rejects(
      () => getPublicReviewBatch({ token: otherLink.token }),
      (error) => error.code === 'REVIEW_TOKEN_EXPIRED',
    );
    await revokeReviewBatch({ sheetsUrl, batchId: batch.batchId });
    await assert.rejects(
      () => getPublicReviewBatch({ token: link.token }),
      (error) => error.code === 'REVIEW_TOKEN_INVALID',
    );
  } finally {
    resetCreativeReviewServiceDependenciesForTest();
  }
});

test('Studio HTTP review endpoints reuse versioned decisions and idempotent publication without a public token', async () => {
  const workspace = createFakeGoogleWorkspace();
  const publicationCalls = [];
  setCreativeReviewServiceDependenciesForTest({
    ...workspace.dependencies,
    ingestApprovedReviewCreative: async ({ item }) => {
      publicationCalls.push(item.review_item_id);
      return {
        status: 'stored',
        creativeId: `library-${item.review_item_id}`,
        imageHash: item.image_hash,
      };
    },
  });
  const previousMode = process.env.APP_MODE;
  const previousWriterBaseUrl = process.env.CREATIVE_REVIEW_WRITER_BASE_URL;
  process.env.APP_MODE = 'studio';
  delete process.env.CREATIVE_REVIEW_WRITER_BASE_URL;
  let server;

  try {
    const sheetsUrl = 'https://docs.google.com/spreadsheets/d/sheet_studio_http/edit';
    const batch = await createReviewBatch({
      sheetsUrl,
      title: 'Studio visual review',
      sourceType: 'batch_sheets',
      category: 'Generic',
      plazas: 'AR',
    });
    const registered = await registerReviewItems({
      sheetsUrl,
      batchId: batch.batchId,
      items: [{
        itemId: 'studio-item',
        generationId: 'studio-generation-1',
        familyId: 'studio-family',
        variantIndex: 1,
        imageUrl: await imageDataUrl(100, 100),
        category: 'Generic',
        plazas: 'AR',
        sourceTab: 'RIDERS | AR',
        sourceRowNumber: 2,
        sourceCell: 'D2',
      }],
    });
    const { app } = await import(`../server/index.js?studio-review-test=${Date.now()}`);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}/api/creative-reviews/batches/${encodeURIComponent(batch.batchId)}`;

    const payloadResponse = await fetch(`${baseUrl}?sheetsUrl=${encodeURIComponent(sheetsUrl)}`);
    assert.equal(payloadResponse.status, 200);
    assert.match(payloadResponse.headers.get('cache-control'), /no-store/);
    const payload = await payloadResponse.json();
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0].review_item_id, 'studio-item');
    assert.equal(payload.status, 'draft');

    const missingVersionResponse = await fetch(`${baseUrl}/decisions`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sheetsUrl,
        decisions: [{ reviewItemId: 'studio-item', status: 'approved' }],
      }),
    });
    assert.equal(missingVersionResponse.status, 409);
    assert.equal((await missingVersionResponse.json()).code, 'REVIEW_VERSION_REQUIRED');
    const unchangedDraftResponse = await fetch(`${baseUrl}?sheetsUrl=${encodeURIComponent(sheetsUrl)}`);
    assert.equal((await unchangedDraftResponse.json()).status, 'draft');

    const decisionBody = {
      sheetsUrl,
      decisions: [{
        id: 'studio-item',
        decision: 'approved',
        version: registered.items[0].version,
      }],
    };
    const decisionResponse = await fetch(`${baseUrl}/decisions`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(decisionBody),
    });
    assert.equal(decisionResponse.status, 200);
    const decided = await decisionResponse.json();
    assert.equal(decided.batch.status, 'in_review');
    assert.equal(decided.batch.token_hash, '', 'Studio does not mint a public review token');
    assert.equal(decided.summary.approved, 1);
    assert.equal(decided.items[0].version, 2);

    const idempotentDecisionResponse = await fetch(`${baseUrl}/decisions`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(decisionBody),
    });
    assert.equal(idempotentDecisionResponse.status, 200);
    assert.equal((await idempotentDecisionResponse.json()).items[0].version, 2);

    const conflictResponse = await fetch(`${baseUrl}/decisions`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sheetsUrl,
        decisions: [{
          reviewItemId: 'studio-item',
          status: 'rejected',
          reason: 'A different decision from a stale screen',
          expectedVersion: 1,
        }],
      }),
    });
    assert.equal(conflictResponse.status, 409);
    assert.equal((await conflictResponse.json()).code, 'REVIEW_VERSION_CONFLICT');

    const finalizeBody = {
      sheetsUrl,
      reviewerName: 'Studio Reviewer',
      reviewerEmail: 'studio@example.com',
    };
    const finalizeResponse = await fetch(`${baseUrl}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(finalizeBody),
    });
    assert.equal(finalizeResponse.status, 200);
    const finalized = await finalizeResponse.json();
    assert.equal(finalized.batch.status, 'published');
    assert.equal(finalized.publication.length, 1);
    assert.deepEqual(publicationCalls, ['studio-item']);

    const idempotentFinalizeResponse = await fetch(`${baseUrl}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sheetsUrl }),
    });
    assert.equal(idempotentFinalizeResponse.status, 200);
    assert.deepEqual((await idempotentFinalizeResponse.json()).publication, []);
    assert.deepEqual(publicationCalls, ['studio-item']);

    const decidedDraft = await createReviewBatch({
      sheetsUrl,
      title: 'Already decided legacy draft',
      sourceType: 'legacy_import',
      category: 'Generic',
      plazas: 'AR',
    });
    await registerReviewItems({
      sheetsUrl,
      batchId: decidedDraft.batchId,
      allowImportedDecision: true,
      reviewerName: 'Legacy import',
      items: [{
        itemId: 'studio-decided-draft-item',
        generationId: 'studio-decided-draft-generation',
        familyId: 'studio-decided-draft-family',
        variantIndex: 1,
        imageUrl: await imageDataUrl(100, 100, '#336699'),
        category: 'Generic',
        plazas: 'AR',
        decision: 'approved',
        sourceTab: 'RIDERS | AR',
        sourceRowNumber: 3,
        sourceCell: 'D3',
      }],
    });
    const decidedDraftUrl = `http://127.0.0.1:${port}/api/creative-reviews/batches/${encodeURIComponent(decidedDraft.batchId)}`;
    const directFinalizeResponse = await fetch(`${decidedDraftUrl}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(finalizeBody),
    });
    assert.equal(directFinalizeResponse.status, 200);
    const directFinalized = await directFinalizeResponse.json();
    assert.equal(directFinalized.batch.status, 'published');
    assert.equal(directFinalized.batch.token_hash, '');
    assert.deepEqual(publicationCalls, ['studio-item', 'studio-decided-draft-item']);
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    if (previousMode === undefined) delete process.env.APP_MODE;
    else process.env.APP_MODE = previousMode;
    if (previousWriterBaseUrl === undefined) delete process.env.CREATIVE_REVIEW_WRITER_BASE_URL;
    else process.env.CREATIVE_REVIEW_WRITER_BASE_URL = previousWriterBaseUrl;
    resetCreativeReviewServiceDependenciesForTest();
  }
});

test('legacy import backs up before writes and maps every cell color independently', async () => {
  const squareApproved = await sharp({ create: { width: 100, height: 100, channels: 4, background: '#11aa44' } }).png().toBuffer();
  const squarePending = await sharp({ create: { width: 100, height: 100, channels: 4, background: '#777777' } }).png().toBuffer();
  const portraitRejected = await sharp({ create: { width: 90, height: 160, channels: 4, background: '#bb2244' } }).png().toBuffer();
  const headerValues = ['Categoría', 'Plaza', 'Reference', '1:1', '', '9:16', 'Feedback 16:9'];
  const gridHeader = { values: headerValues.map(primitiveCell) };
  const linkCell = (fileId, backgroundColor) => ({
    userEnteredValue: { stringValue: `https://drive.google.com/file/d/${fileId}/view` },
    formattedValue: `https://drive.google.com/file/d/${fileId}/view`,
    hyperlink: `https://drive.google.com/file/d/${fileId}/view`,
    effectiveFormat: backgroundColor ? { backgroundColor } : {},
    userEnteredFormat: backgroundColor ? { backgroundColor } : {},
  });
  const gridRow = {
    values: [
      primitiveCell('Generic'),
      primitiveCell('AR'),
      primitiveCell(''),
      linkCell('approved-square', { red: 0, green: 1, blue: 0 }),
      linkCell('pending-square'),
      linkCell('rejected-portrait', { red: 1, green: 0, blue: 0 }),
      primitiveCell('Change the CTA'),
    ],
  };
  const workspace = createFakeGoogleWorkspace({
    sourceRows: [
      headerValues,
      ['Generic', 'AR', '', 'https://drive.google.com/file/d/approved-square/view', 'https://drive.google.com/file/d/pending-square/view', 'https://drive.google.com/file/d/rejected-portrait/view', 'Change the CTA'],
    ],
    sourceGridRows: [gridHeader, gridRow],
    driveImages: {
      'approved-square': squareApproved,
      'pending-square': squarePending,
      'rejected-portrait': portraitRejected,
    },
  });
  const publishedItemIds = [];
  setCreativeReviewServiceDependenciesForTest({
    ...workspace.dependencies,
    ingestApprovedReviewCreative: async ({ item }) => {
      publishedItemIds.push(item.review_item_id);
      return {
        status: 'stored',
        creativeId: `library-${item.review_item_id}`,
        imageHash: item.image_hash,
      };
    },
  });

  try {
    const sheetsUrl = 'https://docs.google.com/spreadsheets/d/sheet_legacy/edit';
    const imported = await importLegacyReviewBatch({
      sheetsUrl,
      sheetName: 'RIDERS | AR',
      title: 'Legacy Riders AR',
    });
    assert.equal(imported.backup.fileId, 'backup-1');
    assert.equal(imported.importedCount, 3);
    const byCell = new Map(imported.items.map((item) => [item.source_cell, item]));
    assert.equal(byCell.get('D2').decision, 'approved');
    assert.equal(byCell.get('E2').decision, 'pending', 'blank cell does not inherit the adjacent green approval');
    assert.equal(byCell.get('F2').decision, 'rejected');
    assert.equal(byCell.get('F2').feedback, 'Change the CTA');

    const backupOperation = workspace.operations.find((entry) => entry.type === 'drive.copy');
    assert.deepEqual(backupOperation.parents, ['folder-Creative Review Backups']);
    assert.equal(
      workspace.operations.filter((entry) => entry.type === 'drive.folder' && entry.name === 'Creative Reviews').length,
      1,
      'the review root is resolved once for the entire import',
    );
    assert.equal(
      workspace.operations.filter((entry) => entry.type === 'drive.folder' && entry.name === imported.batch.batchId).length,
      1,
      'the batch folder is reused for every imported image',
    );

    const backupIndex = workspace.operations.findIndex((entry) => entry.type === 'drive.copy');
    const firstNormalizedWrite = workspace.operations.findIndex((entry) => (
      entry.type === 'addSheet' || entry.type === 'values.update' || entry.type === 'values.append'
    ));
    assert.equal(backupIndex >= 0 && backupIndex < firstNormalizedWrite, true);

    const second = await importLegacyReviewBatch({ sheetsUrl, sheetName: 'RIDERS | AR' });
    assert.equal(second.alreadyImported, true);
    assert.equal(workspace.operations.filter((entry) => entry.type === 'drive.copy').length, 1);

    const link = await issueReviewLink({ sheetsUrl, batchId: imported.batch.batchId });
    await saveReviewDecisions({
      token: link.token,
      decisions: [{
        reviewItemId: byCell.get('E2').review_item_id,
        status: 'approved',
        expectedVersion: byCell.get('E2').version,
      }],
    });
    const finalized = await finalizeReviewBatch({
      token: link.token,
      reviewerName: 'Client Reviewer',
      reviewerEmail: 'client@example.com',
    });
    assert.equal(finalized.batch.status, 'published');
    assert.deepEqual(
      publishedItemIds.sort(),
      [byCell.get('D2').review_item_id, byCell.get('E2').review_item_id].sort(),
    );
    assert.equal(
      finalized.items.find((item) => item.review_item_id === byCell.get('F2').review_item_id).publication_status,
      'not_published',
    );
    const idempotentFinalize = await finalizeReviewBatch({ token: link.token });
    assert.deepEqual(idempotentFinalize.publication, []);
  } finally {
    resetCreativeReviewServiceDependenciesForTest();
  }
});

test('legacy import resumes the same backed-up empty batch after a snapshot failure', async () => {
  const image = await sharp({
    create: { width: 100, height: 100, channels: 4, background: '#663399' },
  }).png().toBuffer();
  const headerValues = ['Category', 'Plaza', '1:1'];
  const linkCell = (fileId) => ({
    userEnteredValue: { stringValue: `https://drive.google.com/file/d/${fileId}/view` },
    formattedValue: `https://drive.google.com/file/d/${fileId}/view`,
    hyperlink: `https://drive.google.com/file/d/${fileId}/view`,
  });
  const workspace = createFakeGoogleWorkspace({
    sourceRows: [
      headerValues,
      ['Generic', 'AR', 'https://drive.google.com/file/d/first/view'],
      ['Generic', 'AR', 'https://drive.google.com/file/d/second/view'],
    ],
    sourceGridRows: [
      { values: headerValues.map(primitiveCell) },
      { values: [primitiveCell('Generic'), primitiveCell('AR'), linkCell('first')] },
      { values: [primitiveCell('Generic'), primitiveCell('AR'), linkCell('second')] },
    ],
    driveImages: { first: image, second: image },
  });
  let failSnapshot = true;
  setCreativeReviewServiceDependenciesForTest({
    ...workspace.dependencies,
    uploadBufferToDrive: async (...args) => {
      if (failSnapshot) {
        failSnapshot = false;
        throw new Error('temporary snapshot failure');
      }
      return workspace.dependencies.uploadBufferToDrive(...args);
    },
  });

  try {
    const sheetsUrl = 'https://docs.google.com/spreadsheets/d/sheet_legacy_resume/edit';
    await assert.rejects(
      () => importLegacyReviewBatch({ sheetsUrl, sheetName: 'RIDERS | AR' }),
      /temporary snapshot failure/,
    );
    const itemTableAfterFailure = workspace.tables.get('creative_review_items');
    assert.equal(itemTableAfterFailure.rows.length, 1, 'no partial normalized item set is exposed');

    setCreativeReviewServiceDependenciesForTest(workspace.dependencies);
    const resumed = await importLegacyReviewBatch({ sheetsUrl, sheetName: 'RIDERS | AR' });
    assert.equal(resumed.importedCount, 2);
    assert.equal(resumed.items.length, 2);
    assert.equal(workspace.operations.filter((entry) => entry.type === 'drive.copy').length, 1);
  } finally {
    resetCreativeReviewServiceDependenciesForTest();
  }
});

test('legacy import normalizes a 43:24 export into its declared 16:9 review bucket', async () => {
  const nearLandscape = await sharp({
    create: { width: 172, height: 96, channels: 4, background: '#4455aa' },
  }).png().toBuffer();
  const headerValues = ['Category', 'Plaza', '16.9 IMG'];
  const imageUrl = 'https://drive.google.com/file/d/near-landscape/view';
  const imageCell = {
    userEnteredValue: { stringValue: imageUrl },
    formattedValue: imageUrl,
    hyperlink: imageUrl,
  };
  const workspace = createFakeGoogleWorkspace({
    sourceRows: [headerValues, ['Generic', 'AR', imageUrl]],
    sourceGridRows: [
      { values: headerValues.map(primitiveCell) },
      { values: [primitiveCell('Generic'), primitiveCell('AR'), imageCell] },
    ],
    driveImages: { 'near-landscape': nearLandscape },
  });
  setCreativeReviewServiceDependenciesForTest(workspace.dependencies);

  try {
    const imported = await importLegacyReviewBatch({
      sheetsUrl: 'https://docs.google.com/spreadsheets/d/sheet_legacy_near_ratio/edit',
      sheetName: 'RIDERS | AR',
    });
    assert.equal(imported.items.length, 1);
    assert.equal(imported.items[0].aspect_ratio, '16:9');
  } finally {
    resetCreativeReviewServiceDependenciesForTest();
  }
});
