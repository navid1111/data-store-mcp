
import dotenv from 'dotenv';
import pg from 'pg';
import url from 'url';

dotenv.config();

const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
    console.error('DATABASE_URL is missing from .env');
    process.exit(1);
}

try {
    const parsed = new url.URL(dbUrl);
    console.log('Attempting to connect to:');
    console.log(`Host: ${parsed.hostname}`);
    console.log(`Port: ${parsed.port}`);
    console.log(`Database: ${parsed.pathname.split('/')[1]}`);
    console.log(`User: ${parsed.username}`);
    console.log(`SSL: true (rejectUnauthorized: false)`);
} catch (e) {
    console.error('Failed to parse DATABASE_URL:', e);
}

const client = new pg.Client({
    connectionString: dbUrl,
    ssl: {
        rejectUnauthorized: false
    },
    connectionTimeoutMillis: 5000, // Fail fast after 5s
});

console.log('Client created. Connecting...');

client.connect((err) => {
    if (err) {
        console.error('Connection error details:', err);
        console.error('Stack:', err.stack);
    } else {
        console.log('SUCCESS! Connected to database.');
        client.query('SELECT NOW()', (err, res) => {
            if (err) console.error('Query error:', err);
            else console.log('Current Database Time:', res.rows[0].now);
            client.end();
        });
    }
});
