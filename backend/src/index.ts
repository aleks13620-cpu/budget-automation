import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { getDatabase, initializeDatabase } from './database';
import specificationRoutes from './routes/specifications';
import invoiceRoutes from './routes/invoices';
import supplierRoutes from './routes/suppliers';
import matchingRoutes from './routes/matching';
import exportRoutes from './routes/export';
import unitTriggerRoutes from './routes/unitTriggers';

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
app.use(unitTriggerRoutes);

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
    console.error('GET /api/projects error:', error);
    res.status(500).json({ error: 'Ошибка при получении проектов' });
  }
});

app.post('/api/projects', (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Название проекта обязательно' });
    }

    const db = getDatabase();
    const result = db.prepare(
      'INSERT INTO projects (name, description) VALUES (?, ?)'
    ).run(name, description || null);

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(project);
  } catch (error) {
    console.error('POST /api/projects error:', error);
    res.status(500).json({ error: 'Ошибка при создании проекта' });
  }
});

app.get('/api/projects/:id', (req, res) => {
  try {
    const db = getDatabase();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);

    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    res.json(project);
  } catch (error) {
    console.error('GET /api/projects/:id error:', error);
    res.status(500).json({ error: 'Ошибка при получении проекта' });
  }
});

// PUT /api/projects/:id — update project
app.put('/api/projects/:id', (req, res) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const { name, description } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Название проекта обязательно' });
    }

    const db = getDatabase();
    const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!existing) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    db.prepare('UPDATE projects SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(String(name).trim(), description ? String(description).trim() : null, projectId);

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    res.json(project);
  } catch (error) {
    console.error('PUT /api/projects/:id error:', error);
    res.status(500).json({ error: 'Ошибка при обновлении проекта' });
  }
});

// DELETE /api/projects/:id — delete project + all related data + files
app.delete('/api/projects/:id', (req, res) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!existing) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    // Get invoice file paths before deleting
    const invoiceFiles = db.prepare(
      'SELECT file_path FROM invoices WHERE project_id = ? AND file_path IS NOT NULL'
    ).all(projectId) as { file_path: string }[];

    // Delete project (CASCADE will delete specs, invoices, items, matches)
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

    // Clean up invoice files from disk
    for (const { file_path } of invoiceFiles) {
      if (file_path) {
        fs.unlink(file_path, () => {});
      }
    }

    res.json({ deleted: true });
  } catch (error) {
    console.error('DELETE /api/projects/:id error:', error);
    res.status(500).json({ error: 'Ошибка при удалении проекта' });
  }
});

// Serve frontend static files (production/Docker)
const frontendDist = path.resolve(
  process.env.FRONTEND_DIST_PATH || path.join(__dirname, '../../frontend/dist')
);
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

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
