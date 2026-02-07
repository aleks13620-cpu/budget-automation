import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { getDatabase, initializeDatabase } from './database';
import specificationRoutes from './routes/specifications';
import invoiceRoutes from './routes/invoices';
import supplierRoutes from './routes/suppliers';
import matchingRoutes from './routes/matching';
import exportRoutes from './routes/export';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use(specificationRoutes);
app.use(invoiceRoutes);
app.use(supplierRoutes);
app.use(matchingRoutes);
app.use(exportRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  try {
    const db = getDatabase();
    const result = db.prepare('SELECT 1 as ok').get() as { ok: number };

    res.json({
      status: 'ok',
      database: result.ok === 1 ? 'connected' : 'error',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      database: 'disconnected',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Projects endpoints (basic CRUD)
app.get('/api/projects', (req, res) => {
  try {
    const db = getDatabase();
    const projects = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

app.post('/api/projects', (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Project name is required' });
    }

    const db = getDatabase();
    const result = db.prepare(
      'INSERT INTO projects (name, description) VALUES (?, ?)'
    ).run(name, description || null);

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(project);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create project' });
  }
});

app.get('/api/projects/:id', (req, res) => {
  try {
    const db = getDatabase();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json(project);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

// Initialize database and start server
async function start() {
  try {
    console.log('Initializing database...');
    initializeDatabase();

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/api/health`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
