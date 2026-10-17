import { cursorPage, cursorPaginationArgs } from './cursor-pagination.dto.js';

describe('cursor pagination helpers', () => {
  it('uses the cursor as an exclusive start and fetches one extra row', () => {
    expect(cursorPaginationArgs('secret-2', 20)).toEqual({
      cursor: { id: 'secret-2' },
      skip: 1,
      take: 21,
    });
  });

  it('returns a next cursor only when another page exists', () => {
    expect(
      cursorPage([{ id: 'row-3' }, { id: 'row-2' }, { id: 'row-1' }], 2),
    ).toEqual({
      items: [{ id: 'row-3' }, { id: 'row-2' }],
      nextCursor: 'row-2',
    });
    expect(cursorPage([{ id: 'row-1' }], 2)).toEqual({
      items: [{ id: 'row-1' }],
      nextCursor: null,
    });
  });
});
