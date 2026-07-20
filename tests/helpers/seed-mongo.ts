/**
 * Seeds a small film/actor dataset into MongoDB, mirroring the shape of Pagila
 * and Sakila so the same kinds of assertions apply across all three sources.
 *
 * Includes embedded fields, heterogeneous values, and a lookup-backed view so
 * the Phase 4 document-to-MDL mapping is exercised against real Mongo metadata.
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
  return Array.from({ length: SEEDED.films }, (_, i) => {
    const lead = ACTORS[i % ACTORS.length];
    return {
      film_id: i + 1,
      title: `TEST FILM ${String(i + 1).padStart(3, '0')}`,
      release_year: 2000 + (i % 10),
      rental_rate: Number((0.99 + (i % 4)).toFixed(2)),
      length: 60 + i * 7,
      rating: RATINGS[i % RATINGS.length],
      lead_actor_id: lead.actor_id,
      // Deliberately heterogeneous across the sample.
      catalog_code: i === 0 ? 1001 : `CAT-${i + 1}`,
      metadata: {
        language: 'en',
        dimensions: { runtime_minutes: 60 + i * 7 },
      },
      // Embedded array documents become dotted, repeated MDL columns.
      actors: ACTORS.slice(0, (i % 3) + 1).map((a) => ({
        actor_id: a.actor_id,
        full_name: `${a.first_name} ${a.last_name}`,
      })),
      // A late optional field proves inference samples more than one document.
      ...(i === SEEDED.films - 1 ? { festival_award: 'JURY_PRIZE' } : {}),
    };
  });
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
    await db.createCollection('film_actor_lookup', {
      viewOn: 'film',
      pipeline: [{
        $lookup: {
          from: 'actor',
          localField: 'lead_actor_id',
          foreignField: 'actor_id',
          as: 'lead_actor',
        },
      }],
    }).catch((error) => {
      // Parallel test files seed the same fixture. An already-created view
      // with this stable definition is the desired state.
      if ((error as { code?: number }).code !== 48) throw error;
    });
  } finally {
    await client.close();
  }
}
