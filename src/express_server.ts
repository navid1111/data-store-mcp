
import express from 'express';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

// Manual connection pool
// Expecting DATABASE_URL in .env, e.g. postgres://user:password@host:port/dbname?sslmode=require
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Neon often needs this for simple connections if CA isn't set up
    }
});

// Test connection on startup
pool.connect((err, _client, release) => {
    if (err) {
        console.error('Error acquiring client', err.stack);
    } else {
        console.log('Successfully connected to database');
        release();
    }
});

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

app.post('/connect', async (_req, res) => {
    // Explicitly test connection
    try {
        const client = await pool.connect();
        const result = await client.query('SELECT NOW()');
        client.release();
        res.json({ success: true, time: result.rows[0].now });
    } catch (err) {
        console.error('Connection failed:', err);
        res.status(500).json({ success: false, error: (err as Error).message });
    }
});

app.post('/query', async (req, res) => {
    const { sql, params } = req.body;
    if (!sql) {
        return res.status(400).json({ error: 'SQL is required' });
    }

    try {
        const result = await pool.query(sql, params || []);
        return res.json({ rows: result.rows, rowCount: result.rowCount });
    } catch (err) {
        console.error('Query failed:', err);
        return res.status(500).json({ error: (err as Error).message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
