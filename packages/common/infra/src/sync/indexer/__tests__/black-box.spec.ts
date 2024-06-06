/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, test } from 'vitest';

import { Document, Index } from '..';
import { IndexedDBIndex } from '../impl/indexeddb';
import { MemoryIndex } from '../impl/memory';

const schema = {
  title: 'FullText',
  tag: 'String',
  size: 'Integer',
} as const;

let index: Index<typeof schema> = null!;

describe.each([
  { name: 'memory', backend: MemoryIndex },
  { name: 'idb', backend: IndexedDBIndex },
])('impl tests($name)', ({ backend }) => {
  async function initData(
    data: Record<
      string,
      Partial<Record<keyof typeof schema, string | string[]>>
    >
  ) {
    const writer = await index.write();
    for (const [id, item] of Object.entries(data)) {
      const doc = new Document(id);
      for (const [key, value] of Object.entries(item)) {
        if (Array.isArray(value)) {
          for (const v of value) {
            doc.insert(key, v);
          }
        } else {
          doc.insert(key, value);
        }
      }
      writer.insert(doc);
    }
    await writer.commit();
  }

  beforeEach(async () => {
    index = new Index(schema, new backend());
    await index.initialize(true);
  });

  test('basic', async () => {
    await initData({
      '1': {
        title: 'hello world',
      },
    });

    const result = await index.search({
      type: 'match',
      field: 'title',
      match: 'hello world',
    });

    expect(result).toEqual({
      nodes: [
        {
          id: '1',
          score: expect.anything(),
        },
      ],
      pagination: {
        count: 1,
        hasMore: false,
        limit: expect.anything(),
        skip: 0,
      },
    });
  });

  test('basic integer', async () => {
    await initData({
      '1': {
        title: 'hello world',
        size: '100',
      },
    });

    const result = await index.search({
      type: 'match',
      field: 'size',
      match: '100',
    });

    expect(result).toEqual({
      nodes: [
        {
          id: '1',
          score: expect.anything(),
        },
      ],
      pagination: {
        count: 1,
        hasMore: false,
        limit: expect.anything(),
        skip: 0,
      },
    });
  });

  test('fuzz', async () => {
    await initData({
      '1': {
        title: 'hello world',
      },
    });
    const result = await index.search({
      type: 'match',
      field: 'title',
      match: 'hell',
    });

    expect(result).toEqual({
      nodes: [
        {
          id: '1',
          score: expect.anything(),
        },
      ],
      pagination: {
        count: 1,
        hasMore: false,
        limit: expect.anything(),
        skip: 0,
      },
    });
  });

  test('highlight', async () => {
    await initData({
      '1': {
        title: 'hello world',
        size: '100',
      },
    });

    const result = await index.search(
      {
        type: 'match',
        field: 'title',
        match: 'hello',
      },
      {
        highlights: [
          {
            field: 'title',
            before: '<b>',
            end: '</b>',
          },
        ],
      }
    );

    expect(result).toEqual({
      nodes: expect.arrayContaining([
        {
          id: '1',
          score: expect.anything(),
          highlights: {
            title: [expect.stringContaining('<b>hello</b>')],
          },
        },
      ]),
      pagination: {
        count: 1,
        hasMore: false,
        limit: expect.anything(),
        skip: 0,
      },
    });
  });

  test('fields', async () => {
    await initData({
      '1': {
        title: 'hello world',
        tag: ['car', 'bike'],
      },
    });

    const result = await index.search(
      {
        type: 'match',
        field: 'title',
        match: 'hello',
      },
      {
        fields: ['title', 'tag'],
      }
    );

    expect(result.nodes[0].fields).toEqual({
      title: 'hello world',
      tag: expect.arrayContaining(['bike', 'car']),
    });
  });

  test('pagination', async () => {
    await initData(
      Array.from({ length: 100 }).reduce((acc: any, _, i) => {
        acc['apple' + i] = {
          tag: ['apple'],
        };
        return acc;
      }, {}) as any
    );

    const result = await index.search(
      {
        type: 'match',
        field: 'tag',
        match: 'apple',
      },
      {
        pagination: {
          skip: 0,
          limit: 10,
        },
      }
    );

    expect(result).toEqual({
      nodes: expect.arrayContaining(
        Array.from({ length: 10 }).fill({
          id: expect.stringContaining('apple'),
          score: expect.anything(),
        })
      ),
      pagination: {
        count: 100,
        hasMore: true,
        limit: 10,
        skip: 0,
      },
    });

    const result2 = await index.search(
      {
        type: 'match',
        field: 'tag',
        match: 'apple',
      },
      {
        pagination: {
          skip: 10,
          limit: 10,
        },
      }
    );

    expect(result2).toEqual({
      nodes: expect.arrayContaining(
        Array.from({ length: 10 }).fill({
          id: expect.stringContaining('apple'),
          score: expect.anything(),
        })
      ),
      pagination: {
        count: 100,
        hasMore: true,
        limit: 10,
        skip: 10,
      },
    });
  });

  test('aggr', async () => {
    await initData({
      '1': {
        title: 'hello world',
        tag: ['car', 'bike'],
      },
      affine1: {
        title: 'affine',
        tag: ['motorcycle', 'bike'],
      },
      affine2: {
        title: 'affine',
        tag: ['motorcycle', 'airplane'],
      },
    });

    const result = await index.aggregate(
      {
        type: 'match',
        field: 'title',
        match: 'affine',
      },
      'tag'
    );

    expect(result).toEqual({
      buckets: expect.arrayContaining([
        { key: 'motorcycle', count: 2, score: expect.anything() },
        { key: 'bike', count: 1, score: expect.anything() },
        { key: 'airplane', count: 1, score: expect.anything() },
      ]),
      pagination: {
        count: 3,
        hasMore: false,
        limit: expect.anything(),
        skip: 0,
      },
    });
  });

  test('hits', async () => {
    await initData(
      Array.from({ length: 100 }).reduce((acc: any, _, i) => {
        acc['apple' + i] = {
          title: 'apple',
          tag: ['apple', 'fruit'],
        };
        return acc;
      }, {}) as any
    );
    const result = await index.aggregate(
      {
        type: 'match',
        field: 'title',
        match: 'apple',
      },
      'tag',
      {
        hits: {
          pagination: {
            skip: 0,
            limit: 5,
          },
          highlights: [
            {
              field: 'title',
              before: '<b>',
              end: '</b>',
            },
          ],
          fields: ['title', 'tag'],
        },
      }
    );

    expect(result).toEqual({
      buckets: expect.arrayContaining([
        {
          key: 'apple',
          count: 100,
          score: expect.anything(),
          hits: {
            pagination: {
              count: 100,
              hasMore: true,
              limit: 5,
              skip: 0,
            },
            nodes: expect.arrayContaining(
              Array.from({ length: 5 }).fill({
                id: expect.stringContaining('apple'),
                score: expect.anything(),
                highlights: {
                  title: [expect.stringContaining('<b>apple</b>')],
                },
                fields: {
                  title: expect.stringContaining('apple'),
                  tag: expect.arrayContaining(['apple', 'fruit']),
                },
              })
            ),
          },
        },
        {
          key: 'fruit',
          count: 100,
          score: expect.anything(),
          hits: {
            pagination: {
              count: 100,
              hasMore: true,
              limit: 5,
              skip: 0,
            },
            nodes: expect.arrayContaining(
              Array.from({ length: 5 }).fill({
                id: expect.stringContaining('apple'),
                score: expect.anything(),
                highlights: {
                  title: [expect.stringContaining('<b>apple</b>')],
                },
                fields: {
                  title: expect.stringContaining('apple'),
                  tag: expect.arrayContaining(['apple', 'fruit']),
                },
              })
            ),
          },
        },
      ]),
      pagination: {
        count: 2,
        hasMore: false,
        limit: expect.anything(),
        skip: 0,
      },
    });
  });
});
