/**
 * Seeds a small film/actor dataset into MongoDB, mirroring the shape of Pagila
 * and Sakila so the same kinds of assertions apply across all three sources.
 *
 * Deliberately denormalized (actors embedded in films) because that is how the
 * data would realistically be modeled in a document store — which is exactly
 * why spec.md D2 excludes Mongo from the relational MDL for now.
 */

import { MongoClient } from 'mongodb';
import { MONGO } from './sources.js';

export const SEEDED = {
  films: 12,
  actors: 8,
} as const;

const ACTORS = [
  { actor_id: 1, first_name: 'PENELOPE', last_name: 'GUINESS' },
  { actor_id: 2, first_name: 'NICK', last_name: 'WAHLBERG' },
  { actor_id: 3, first_name: 'ED', last_name: 'CHASE' },
  { actor_id: 4, first_name: 'JENNIFER', last_name: 'DAVIS' },
  { actor_id: 5, first_name: 'JOHNNY', last_name: 'LOLLOBRIGIDA' },
  { actor_id: 6, first_name: 'BETTE', last_name: 'NICHOLSON' },
  { actor_id: 7, first_name: 'GRACE', last_name: 'MOSTEL' },
  { actor_id: 8, first_name: 'MATTHEW', last_name: 'JOHANSSON' },
];

const RATINGS = ['G', 'PG', 'PG-13', 'R', 'NC-17'];

function buildFilms() {
  return Array.from({ length: SEEDED.films }, (_, i) => ({
    film_id: i + 1,
    title: `TEST FILM ${String(i + 1).padStart(3, '0')}`,
    release_year: 2000 + (i % 10),
    rental_rate: Number((0.99 + (i % 4)).toFixed(2)),
    length: 60 + i * 7,
    rating: RATINGS[i % RATINGS.length],
    // embedded, not a foreign key — the document-store idiom
    actors: ACTORS.slice(0, (i % 3) + 1).map((a) => ({
      actor_id: a.actor_id,
      full_name: `${a.first_name} ${a.last_name}`,
    })),
  }));
}

export async function seedMongo(): Promise<void> {
  const client = new MongoClient(MONGO.options.uri);
  try {
    await client.connect();
    const db = client.db(MONGO.options.database);

    await Promise.all([
      db.collection('film').deleteMany({}),
      db.collection('actor').deleteMany({}),
    ]);

    await db.collection('film').insertMany(buildFilms());
    await db.collection('actor').insertMany(ACTORS);

    await db.collection('film').createIndex({ film_id: 1 }, { unique: true });
    await db.collection('film').createIndex({ rating: 1 });
    await db.collection('actor').createIndex({ actor_id: 1 }, { unique: true });
  } finally {
    await client.close();
  }
}
