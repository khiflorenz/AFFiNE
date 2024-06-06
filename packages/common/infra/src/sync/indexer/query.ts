import type { Schema } from './schema';

export type MatchQuery<S extends Schema> = {
  type: 'match';
  field: keyof S;
  match: string;
};

export type BooleanQuery<S extends Schema> = {
  type: 'boolean';
  occur: 'should' | 'must' | 'must_not';
  queries: Query<S>[];
};

export type AllQuery = {
  type: 'all';
};

export type Query<S extends Schema> =
  | BooleanQuery<S>
  | MatchQuery<S>
  | AllQuery;
