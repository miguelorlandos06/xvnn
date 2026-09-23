// services/queue.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
//  CONFIGURACIÓN
// ============================================================
const QUEUE_FILE = path.join(__dirname, '..', 'data', 'batch_queue.json');
const DATA_DIR = path.dirname(QUEUE_FILE);
const MAX_COMPLETED_BATCHES = 50;

// ============================================================
//  ESTADO EN MEMORIA
// ============================================================
let queue = {
  version: 1,
  lastUpdated: null,
  batches: []
};

// ============================================================
//  INICIALIZACIÓN
// ============================================================
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`📁 Directorio de datos creado: ${DATA_DIR}`);
  }
}

export function loadQueue() {
  try {
    ensureDataDir();

    if (!fs.existsSync(QUEUE_FILE)) {
      console.log('📭 No hay cola previa, iniciando vacía');
      queue = { version: 1, lastUpdated: null, batches: [] };
      return queue;
    }

    const content = fs.readFileSync(QUEUE_FILE, 'utf-8');
    const parsed = JSON.parse(content);

    if (!parsed.batches || !Array.isArray(parsed.batches)) {
      throw new Error('Estructura inválida');
    }

    queue = parsed;
    console.log(`📂 Cola cargada: ${queue.batches.length} batches`);
    return queue;
  } catch (err) {
    console.error('⚠️  Error cargando cola:', err.message);
    queue = { version: 1, lastUpdated: null, batches: [] };
    return queue;
  }
}

// ============================================================
//  GUARDAR (con debounce)
// ============================================================
let saveTimer = null;

export function saveQueue(immediate = false) {
  if (saveTimer) clearTimeout(saveTimer);

  const doSave = () => {
    try {
      ensureDataDir();
      queue.lastUpdated = new Date().toISOString();

      // Limpiar batches completados antiguos
      const completed = queue.batches
        .filter(b => b.status === 'completed' || b.status === 'cancelled' || b.status === 'failed')
        .sort((a, b) => new Date(b.finishedAt || b.startedAt) - new Date(a.finishedAt || a.startedAt));

      const toKeep = new Set(completed.slice(0, MAX_COMPLETED_BATCHES).map(b => b.id));

      queue.batches = queue.batches.filter(b => {
        if (b.status === 'pending' || b.status === 'processing') return true;
        return toKeep.has(b.id);
      });

      const tmpFile = `${QUEUE_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(queue, null, 2), 'utf-8');
      fs.renameSync(tmpFile, QUEUE_FILE);
    } catch (err) {
      console.error('⚠️  Error guardando cola:', err.message);
    }
  };

  if (immediate) {
    doSave();
  } else {
    saveTimer = setTimeout(doSave, 2000);
  }
}

// ============================================================
//  CREAR BATCH
// ============================================================
export function createBatch({
  telegramUserId,
  xvnnUserId,
  username,
  chatId,
  messageId,
  category,
  urls
}) {
  const batch = {
    id: generateId(),
    telegramUserId,
    xvnnUserId,
    username,
    chatId,
    messageId,
    category,
    urls: urls.map(url => ({
      url,
      status: 'pending',
      error: null,
      videoId: null,
      attempts: 0
    })),
    total: urls.length,
    processed: 0,
    successCount: 0,
    failedCount: 0,
    status: 'pending',
    currentIndex: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    updatedAt: new Date().toISOString()
  };

  queue.batches.push(batch);
  saveQueue(true);

  console.log(`📦 Batch creado: ${batch.id.slice(0, 8)} (${urls.length} URLs)`);
  return batch;
}

// ============================================================
//  ACTUALIZAR BATCH
// ============================================================
export function updateBatch(batchId, updates) {
  const batch = queue.batches.find(b => b.id === batchId);
  if (!batch) return null;

  Object.assign(batch, updates);
  batch.updatedAt = new Date().toISOString();
  saveQueue();
  return batch;
}

// ============================================================
//  ACTUALIZAR ITEM
// ============================================================
export function updateBatchItem(batchId, index, updates) {
  const batch = queue.batches.find(b => b.id === batchId);
  if (!batch || !batch.urls[index]) return null;

  Object.assign(batch.urls[index], updates);
  batch.updatedAt = new Date().toISOString();
  saveQueue();
  return batch.urls[index];
}

// ============================================================
//  AVANZAR PROGRESO
// ============================================================
export function advanceBatch(batchId, success = true) {
  const batch = queue.batches.find(b => b.id === batchId);
  if (!batch) return null;

  batch.processed++;
  batch.currentIndex = batch.processed;

  if (success) {
    batch.successCount++;
  } else {
    batch.failedCount++;
  }

  batch.updatedAt = new Date().toISOString();

  if (batch.processed >= batch.total) {
    batch.status = 'completed';
    batch.finishedAt = new Date().toISOString();
    console.log(`✅ Batch completado: ${batch.id.slice(0, 8)}`);
  }

  saveQueue(true);
  return batch;
}

// ============================================================
//  MARCAR PROCESANDO
// ============================================================
export function markBatchProcessing(batchId) {
  return updateBatch(batchId, { status: 'processing' });
}

// ============================================================
//  CANCELAR
// ============================================================
export function cancelBatch(batchId) {
  const batch = queue.batches.find(b => b.id === batchId);
  if (!batch) return null;

  batch.status = 'cancelled';
  batch.finishedAt = new Date().toISOString();
  batch.updatedAt = new Date().toISOString();

  saveQueue(true);
  console.log(`🛑 Batch cancelado: ${batchId.slice(0, 8)}`);
  return batch;
}

// ============================================================
//  CONSULTAS
// ============================================================
export function getActiveBatch(telegramUserId) {
  return queue.batches.find(b =>
    b.telegramUserId === telegramUserId &&
    (b.status === 'pending' || b.status === 'processing')
  ) || null;
}

export function getBatch(batchId) {
  return queue.batches.find(b => b.id === batchId) || null;
}

export function getPendingBatches() {
  return queue.batches.filter(b =>
    b.status === 'pending' || b.status === 'processing'
  );
}

export function getUserBatches(telegramUserId, limit = 10) {
  return queue.batches
    .filter(b => b.telegramUserId === telegramUserId)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, limit);
}

export function getQueueStats() {
  return {
    total: queue.batches.length,
    pending: queue.batches.filter(b => b.status === 'pending').length,
    processing: queue.batches.filter(b => b.status === 'processing').length,
    completed: queue.batches.filter(b => b.status === 'completed').length,
    failed: queue.batches.filter(b => b.status === 'failed').length,
    cancelled: queue.batches.filter(b => b.status === 'cancelled').length
  };
}

// ============================================================
//  UTILS
// ============================================================
function generateId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function clearQueue() {
  queue = { version: 1, lastUpdated: new Date().toISOString(), batches: [] };
  saveQueue(true);
  console.log('🗑️  Cola limpiada');
}