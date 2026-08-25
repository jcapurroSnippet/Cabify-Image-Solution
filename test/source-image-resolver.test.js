import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOURCE_ORIGIN_BANK,
  SOURCE_ORIGIN_LOW_PERFORMER,
  resetSourceImageDependencyOverrides,
  resolveSourceImage,
  selectBankImage,
  setSourceImageDependencyOverrides,
} from '../server/services/sourceImageResolver.js';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

const withOverrides = async (overrides, fn) => {
  setSourceImageDependencyOverrides({
    getCreativeLibraryConfig: () => ({ sourceBankFolderId: '' }),
    ...overrides,
  });
  try {
    return await fn();
  } finally {
    resetSourceImageDependencyOverrides();
  }
};

test('the low performer\'s own creative is the preferred source', async () => {
  await withOverrides(
    {
      downloadAdImage: async (url) => {
        assert.equal(url, 'https://ads.example/old.png');
        return PNG_DATA_URL;
      },
      listDriveFolderImages: async () => assert.fail('the bank must not be consulted'),
    },
    async () => {
      const result = await resolveSourceImage({ old_image_url: 'https://ads.example/old.png' });
      assert.equal(result.origin, SOURCE_ORIGIN_LOW_PERFORMER);
      assert.equal(result.dataUrl, PNG_DATA_URL);
      assert.equal(result.sourceUrl, 'https://ads.example/old.png');
      assert.equal(result.error, null);
    },
  );
});

test('a failed download falls back to the Drive bank', async () => {
  await withOverrides(
    {
      downloadAdImage: async () => { throw new Error('403 Forbidden'); },
      listDriveFolderImages: async (folderId) => {
        assert.equal(folderId, 'folder-1');
        return [{ id: 'file-1', name: 'promo-buenos-aires.png', webViewLink: 'https://drive/file-1' }];
      },
      downloadDriveFileAsDataUrl: async (fileId) => {
        assert.equal(fileId, 'file-1');
        return PNG_DATA_URL;
      },
    },
    async () => {
      const result = await resolveSourceImage(
        { old_image_url: 'https://ads.example/old.png', detected_category: 'Promo' },
        { bankFolderId: 'folder-1' },
      );
      assert.equal(result.origin, SOURCE_ORIGIN_BANK);
      assert.equal(result.dataUrl, PNG_DATA_URL);
      assert.equal(result.sourceUrl, 'https://drive/file-1');
    },
  );
});

test('a download that returns something other than an image also falls back', async () => {
  await withOverrides(
    {
      downloadAdImage: async () => 'data:text/html;base64,PGh0bWw+',
      listDriveFolderImages: async () => [{ id: 'file-1', name: 'generic.png' }],
      downloadDriveFileAsDataUrl: async () => PNG_DATA_URL,
    },
    async () => {
      const result = await resolveSourceImage(
        { old_image_url: 'https://ads.example/login.html' },
        { bankFolderId: 'folder-1' },
      );
      assert.equal(result.origin, SOURCE_ORIGIN_BANK);
    },
  );
});

test('with no bank configured the target is reported unresolvable rather than throwing', async () => {
  await withOverrides(
    { downloadAdImage: async () => { throw new Error('timeout'); } },
    async () => {
      const result = await resolveSourceImage({ old_image_url: 'https://ads.example/old.png' });
      assert.equal(result.origin, null);
      assert.equal(result.dataUrl, null);
      assert.match(result.error, /timeout/);
      assert.match(result.error, /CREATIVE_SOURCE_BANK_FOLDER_ID/);
    },
  );
});

test('a target with no image URL at all goes straight to the bank', async () => {
  await withOverrides(
    {
      downloadAdImage: async () => assert.fail('there is nothing to download'),
      listDriveFolderImages: async () => [{ id: 'file-9', name: 'generic.png' }],
      downloadDriveFileAsDataUrl: async () => PNG_DATA_URL,
    },
    async () => {
      const result = await resolveSourceImage({}, { bankFolderId: 'folder-1' });
      assert.equal(result.origin, SOURCE_ORIGIN_BANK);
    },
  );
});

test('an empty bank folder is reported, not treated as success', async () => {
  await withOverrides(
    {
      downloadAdImage: async () => { throw new Error('404'); },
      listDriveFolderImages: async () => [],
    },
    async () => {
      const result = await resolveSourceImage(
        { old_image_url: 'https://ads.example/old.png' },
        { bankFolderId: 'folder-1' },
      );
      assert.equal(result.origin, null);
      assert.match(result.error, /no images/);
    },
  );
});

test('bank selection prefers a file whose name matches the category', () => {
  const files = [
    { id: '1', name: 'generic-01.png' },
    { id: '2', name: 'promo-descuento.png' },
    { id: '3', name: 'alianzas-02.png' },
  ];
  assert.equal(selectBankImage(files, 'Promo').id, '2');
  assert.equal(selectBankImage(files, 'Alianzas').id, '3');
  // No match still returns something usable rather than blocking the run.
  assert.equal(selectBankImage(files, 'Inexistente').id, '1');
  assert.equal(selectBankImage(files, '').id, '1');
  assert.equal(selectBankImage([], 'Promo'), null);
});
