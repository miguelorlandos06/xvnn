-- ============================================================
--  XVNN · Esquema de base de datos
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==================== USUARIOS ====================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  username VARCHAR(50) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower
  ON users (LOWER(username));

-- ==================== VIDEOS ====================
CREATE TABLE IF NOT EXISTS videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  description TEXT DEFAULT '',
  category VARCHAR(20) NOT NULL CHECK(category IN ('Hetero','Gay','Bi','Trans')),
  filename VARCHAR(500) NOT NULL,
  thumbnail VARCHAR(500) NOT NULL,
  duration INTEGER DEFAULT 0,
  size BIGINT DEFAULT 0,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  dislikes INTEGER DEFAULT 0,

  -- HLS
  hls_manifest VARCHAR(500),
  video_type VARCHAR(20) DEFAULT 'mp4' CHECK(video_type IN ('mp4','hls')),
  processing_status VARCHAR(20) DEFAULT 'ready'
    CHECK(processing_status IN ('processing','ready','failed')),
  variants JSONB,

  -- Telegram
  telegram_user_id BIGINT,
  telegram_username VARCHAR(100),
  telegram_message_id BIGINT,
  telegram_file_id VARCHAR(255),
  telegram_chat_id BIGINT,
  telegram_progress_message_id BIGINT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_videos_category ON videos(category);
CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id);
CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(processing_status);
CREATE INDEX IF NOT EXISTS idx_videos_telegram_user ON videos(telegram_user_id);

-- ==================== REACCIONES ====================
CREATE TABLE IF NOT EXISTS reactions (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  type VARCHAR(10) NOT NULL CHECK(type IN ('like','dislike')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, video_id)
);

-- ==================== VISTAS ====================
CREATE TABLE IF NOT EXISTS views_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_views_video ON views_log(video_id);

-- ==================== TRIGGER: contadores ====================
CREATE OR REPLACE FUNCTION update_video_counts()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.type = 'like' THEN
      UPDATE videos SET likes = likes + 1 WHERE id = NEW.video_id;
    ELSE
      UPDATE videos SET dislikes = dislikes + 1 WHERE id = NEW.video_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.type = 'like' THEN
      UPDATE videos SET likes = GREATEST(0, likes - 1) WHERE id = OLD.video_id;
    ELSE
      UPDATE videos SET dislikes = GREATEST(0, dislikes - 1) WHERE id = OLD.video_id;
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.type = 'like' THEN
      UPDATE videos SET likes = GREATEST(0, likes - 1) WHERE id = OLD.video_id;
    ELSE
      UPDATE videos SET dislikes = GREATEST(0, dislikes - 1) WHERE id = OLD.video_id;
    END IF;
    IF NEW.type = 'like' THEN
      UPDATE videos SET likes = likes + 1 WHERE id = NEW.video_id;
    ELSE
      UPDATE videos SET dislikes = dislikes + 1 WHERE id = NEW.video_id;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reactions_counts ON reactions;
CREATE TRIGGER trg_reactions_counts
AFTER INSERT OR UPDATE OR DELETE ON reactions
FOR EACH ROW EXECUTE FUNCTION update_video_counts();

-- ==================== SESIONES DE TELEGRAM ====================
CREATE TABLE IF NOT EXISTS telegram_sessions (
  telegram_user_id BIGINT PRIMARY KEY,
  xvnn_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  xvnn_username VARCHAR(50) NOT NULL,
  state VARCHAR(30) DEFAULT 'authenticated',
  failed_attempts INTEGER DEFAULT 0,
  last_activity TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_sessions_user
  ON telegram_sessions(xvnn_user_id);