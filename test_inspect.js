
import { MssqlDatabase } from './dist/mssql.js';

async function testInspection() {
    const config = {
        id: 'test-mssql-inspect',
        type: 'sqlserver',
        options: {
            host: '172.17.0.1',
            port: 1433,
            user: 'ci_user',
            password: 'Navid@Secure2025!',
            database: 'test_db',
            encrypt: false,
            TrustServerCertificate: false
        }
    };

    console.log('Testing MSSQL Inspection...');

    const db = new MssqlDatabase(config);

    try {
        await db.connect();
        console.log('Connected.');

        console.log('Fetching relations...');
        const relations = await db.getRelations();
        console.log('Relations fetched:', relations.length);
        if (relations.length > 0) {
            console.log('First 3 relations:', relations.slice(0, 3));
        } else {
            console.log('No relations found (this might be expected if the DB has no FKs).');
        }

    } catch (error) {
        console.error('Failed:', error);
        process.exit(1);
    }
}

testInspection();
