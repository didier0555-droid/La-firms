const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'database.sqlite');
const financeSessions = new Map();
const financeLoginAttempts = new Map();
const reviewSubmissions = new Map();
const financeSessionDuration = 8 * 60 * 60 * 1000;
const financeCookieName = 'la_firms_finance';

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error al abrir la base de datos:', err.message);
    return;
  }

  db.serialize(() => {
    db.run(`
    CREATE TABLE IF NOT EXISTS citas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      telefono TEXT NOT NULL,
      direccion TEXT,
      correo TEXT,
      mensaje TEXT,
      appointment_date TEXT,
      appointment_time TEXT,
      service TEXT,
      status TEXT NOT NULL DEFAULT 'pendiente',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
    `, (createErr) => {
      if (createErr) {
        console.error('Error al crear tabla de citas:', createErr.message);
      } else {
        console.log('Base de datos lista.');
        db.all('PRAGMA table_info(citas)', [], (columnsError, columns) => {
          if (columnsError) {
            console.error('Error al comprobar estructura de citas:', columnsError.message);
            return;
          }
          const existingColumns = new Set(columns.map((column) => column.name));
          const requiredColumns = [
            ['appointment_date', 'TEXT'],
            ['appointment_time', 'TEXT'],
            ['service', 'TEXT'],
            ['status', "TEXT NOT NULL DEFAULT 'pendiente'"]
          ];
          db.serialize(() => {
            for (const [column, definition] of requiredColumns) {
              if (existingColumns.has(column)) continue;
              db.run(`ALTER TABLE citas ADD COLUMN ${column} ${definition}`, (alterError) => {
                if (alterError) console.error(`Error al agregar columna ${column} a citas:`, alterError.message);
              });
            }
            db.run('CREATE INDEX IF NOT EXISTS idx_citas_fecha ON citas (appointment_date, appointment_time)', (indexError) => {
              if (indexError) console.error('Error al crear índice de citas:', indexError.message);
            });
          });
        });
      }
    });
    db.run(`
      CREATE TABLE IF NOT EXISTS finance_admin (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL
      )
    `, (createErr) => {
      if (createErr) console.error('Error al crear configuración de finanzas:', createErr.message);
    });
    db.run(`
      CREATE TABLE IF NOT EXISTS finance_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK (type IN ('ingreso', 'gasto')),
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        amount_cop INTEGER NOT NULL CHECK (amount_cop > 0),
        transaction_date TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `, (createErr) => {
      if (createErr) {
        console.error('Error al crear movimientos financieros:', createErr.message);
      }
    });
    db.run(`
      CREATE TABLE IF NOT EXISTS service_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL DEFAULT '',
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `, (createErr) => {
      if (createErr) console.error('Error al crear opiniones de clientes:', createErr.message);
    });
  });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const requestedPath = path.resolve(__dirname, `.${req.path}`).toLowerCase();
  const protectedDatabasePaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
    .map((databasePath) => path.resolve(databasePath).toLowerCase());
  if (protectedDatabasePaths.includes(requestedPath)) return res.sendStatus(404);
  next();
});
app.use(express.static(__dirname));

function colombianMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}`;
}

function validMonth(month) {
  return typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function colombianDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validAppointmentTime(date, time) {
  if (!validDate(date) || typeof time !== 'string' || !/^([01]\d|2[0-3]):(00|30)$/.test(time)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const selectedDate = new Date(Date.UTC(year, month - 1, day));
  const weekDay = selectedDate.getUTCDay();
  const minutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const closingTime = weekDay === 6 ? 21 * 60 : 22 * 60;
  return date >= colombianDate() && weekDay !== 0 && minutes >= 10 * 60 && minutes <= closingTime;
}

function appointmentRow(row) {
  let { appointmentDate, appointmentTime, service } = row;
  if (!appointmentDate || !appointmentTime || !service) {
    const legacyDetails = /Fecha solicitada:\s*(\d{4}-\d{2}-\d{2})\s+a las\s+(\d{2}:\d{2})\.\s*Servicio:\s*([^.]*)/i.exec(row.mensaje || '');
    if (legacyDetails) {
      appointmentDate = appointmentDate || legacyDetails[1];
      appointmentTime = appointmentTime || legacyDetails[2];
      service = service || legacyDetails[3].trim();
    }
  }
  return { ...row, appointmentDate, appointmentTime, service };
}

function financeSession(req) {
  const cookies = (req.headers.cookie || '').split(';');
  const cookie = cookies.map((part) => part.trim()).find((part) => part.startsWith(`${financeCookieName}=`));
  if (!cookie) return null;

  const token = cookie.slice(financeCookieName.length + 1);
  const session = financeSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    financeSessions.delete(token);
    return null;
  }
  return { token, session };
}

function setFinanceSession(req, res) {
  for (const [token, session] of financeSessions) {
    if (session.expiresAt <= Date.now()) financeSessions.delete(token);
  }
  const token = crypto.randomBytes(32).toString('hex');
  financeSessions.set(token, { expiresAt: Date.now() + financeSessionDuration });
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${financeCookieName}=${token}; Path=/api/finanzas; HttpOnly; SameSite=Strict; Max-Age=${financeSessionDuration / 1000}${secure}`);
}

function validSameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === req.get('host') && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
}

function financeAuth(req, res, next) {
  if (!financeSession(req)) return res.status(401).json({ error: 'Inicia sesión para acceder al control financiero.' });
  next();
}

function loginRateLimited(req) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const attempt = financeLoginAttempts.get(key);
  if (!attempt || attempt.resetAt <= Date.now()) {
    financeLoginAttempts.delete(key);
    return false;
  }
  return attempt.failures >= 5;
}

function recordFailedLogin(req) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const previous = financeLoginAttempts.get(key);
  if (!previous || previous.resetAt <= Date.now()) {
    financeLoginAttempts.set(key, { failures: 1, resetAt: Date.now() + 15 * 60 * 1000 });
    return;
  }
  previous.failures += 1;
}

function clearFinanceCookie(res) {
  res.setHeader('Set-Cookie', `${financeCookieName}=; Path=/api/finanzas; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 128;
}

app.get('/api/finanzas/estado', (req, res) => {
  db.get('SELECT id FROM finance_admin WHERE id = 1', [], (err, row) => {
    if (err) {
      console.error('Error al consultar estado de finanzas:', err.message);
      return res.status(500).json({ error: 'No se pudo consultar el acceso al panel.' });
    }
    res.json({ setupRequired: !row, authenticated: Boolean(financeSession(req)) });
  });
});

app.post('/api/finanzas/configurar', (req, res) => {
  if (!validSameOrigin(req)) return res.status(403).json({ error: 'Solicitud de origen no permitido.' });
  if (loginRateLimited(req)) return res.status(429).json({ error: 'Demasiados intentos. Prueba de nuevo en 15 minutos.' });
  const { password } = req.body || {};
  if (!validPassword(password)) {
    return res.status(400).json({ error: 'La contraseña debe tener entre 12 y 128 caracteres.' });
  }

  db.get('SELECT id FROM finance_admin WHERE id = 1', [], (err, row) => {
    if (err) {
      console.error('Error al comprobar configuración de finanzas:', err.message);
      return res.status(500).json({ error: 'No se pudo configurar el acceso.' });
    }
    if (row) return res.status(409).json({ error: 'El panel ya está configurado. Inicia sesión.' });

    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (hashError, passwordHash) => {
      if (hashError) {
        console.error('Error al proteger la contraseña del panel:', hashError.message);
        return res.status(500).json({ error: 'No se pudo configurar el acceso.' });
      }
      db.run(
        'INSERT OR IGNORE INTO finance_admin (id, password_salt, password_hash) VALUES (1, ?, ?)',
        [salt, passwordHash.toString('hex')],
        function (insertError) {
          if (insertError) {
            console.error('Error al guardar acceso de finanzas:', insertError.message);
            return res.status(500).json({ error: 'No se pudo configurar el acceso.' });
          }
          if (this.changes !== 1) return res.status(409).json({ error: 'El panel ya está configurado. Inicia sesión.' });
          setFinanceSession(req, res);
          res.status(201).json({ message: 'Contraseña configurada.' });
        }
      );
    });
  });
});

app.post('/api/finanzas/ingresar', (req, res) => {
  if (!validSameOrigin(req)) return res.status(403).json({ error: 'Solicitud de origen no permitido.' });
  if (loginRateLimited(req)) return res.status(429).json({ error: 'Demasiados intentos. Prueba de nuevo en 15 minutos.' });
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length > 128) {
    recordFailedLogin(req);
    return res.status(401).json({ error: 'La contraseña no es correcta.' });
  }

  db.get('SELECT password_salt, password_hash FROM finance_admin WHERE id = 1', [], (err, admin) => {
    if (err) {
      console.error('Error al consultar contraseña de finanzas:', err.message);
      return res.status(500).json({ error: 'No se pudo iniciar sesión.' });
    }
    if (!admin) return res.status(409).json({ error: 'Configura la contraseña desde el primer acceso.' });

    crypto.scrypt(password, admin.password_salt, 64, (hashError, passwordHash) => {
      if (hashError) {
        console.error('Error al validar contraseña de finanzas:', hashError.message);
        return res.status(500).json({ error: 'No se pudo iniciar sesión.' });
      }
      const storedHash = Buffer.from(admin.password_hash, 'hex');
      if (storedHash.length !== passwordHash.length || !crypto.timingSafeEqual(storedHash, passwordHash)) {
        recordFailedLogin(req);
        return res.status(401).json({ error: 'La contraseña no es correcta.' });
      }
      financeLoginAttempts.delete(req.ip || req.socket.remoteAddress || 'unknown');
      setFinanceSession(req, res);
      res.json({ message: 'Sesión iniciada.' });
    });
  });
});

app.post('/api/finanzas/salir', (req, res) => {
  if (!validSameOrigin(req)) return res.status(403).json({ error: 'Solicitud de origen no permitido.' });
  const activeSession = financeSession(req);
  if (activeSession) financeSessions.delete(activeSession.token);
  clearFinanceCookie(res);
  res.json({ message: 'Sesión cerrada.' });
});

app.get('/api/finanzas/movimientos', financeAuth, (req, res) => {
  const month = req.query.month || colombianMonth();
  if (!validMonth(month)) return res.status(400).json({ error: 'El mes debe tener formato YYYY-MM.' });
  const [year, monthNumber] = month.split('-').map(Number);
  const nextMonth = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);

  db.all(
    `SELECT id, type, category, description, amount_cop AS amountCop, transaction_date AS date
     FROM finance_transactions
     WHERE transaction_date >= ? AND transaction_date < ?
     ORDER BY transaction_date DESC, id DESC`,
    [`${month}-01`, nextMonth],
    (err, rows) => {
      if (err) {
        console.error('Error al consultar movimientos financieros:', err.message);
        return res.status(500).json({ error: 'No se pudieron consultar los movimientos.' });
      }
      const totals = rows.reduce((result, transaction) => {
        if (transaction.type === 'ingreso') result.incomeCop += transaction.amountCop;
        else result.expenseCop += transaction.amountCop;
        return result;
      }, { incomeCop: 0, expenseCop: 0 });
      totals.balanceCop = totals.incomeCop - totals.expenseCop;
      res.json({ transactions: rows, totals });
    }
  );
});

app.post('/api/finanzas/movimientos', financeAuth, (req, res) => {
  if (!validSameOrigin(req)) return res.status(403).json({ error: 'Solicitud de origen no permitido.' });
  const { type, category, description, amount, date } = req.body || {};
  const amountCop = Number(amount);

  if (!['ingreso', 'gasto'].includes(type)) return res.status(400).json({ error: 'Elige ingreso o gasto.' });
  if (typeof category !== 'string' || !category.trim() || category.trim().length > 60) {
    return res.status(400).json({ error: 'La categoría es obligatoria y debe tener máximo 60 caracteres.' });
  }
  if (typeof description !== 'string' || !description.trim() || description.trim().length > 160) {
    return res.status(400).json({ error: 'La descripción es obligatoria y debe tener máximo 160 caracteres.' });
  }
  if (!Number.isSafeInteger(amountCop) || amountCop <= 0) {
    return res.status(400).json({ error: 'Ingresa un valor entero en pesos colombianos mayor que cero.' });
  }
  if (!validDate(date)) return res.status(400).json({ error: 'Elige una fecha válida.' });

  db.run(
    'INSERT INTO finance_transactions (type, category, description, amount_cop, transaction_date) VALUES (?, ?, ?, ?, ?)',
    [type, category.trim(), description.trim(), amountCop, date],
    function (err) {
      if (err) {
        console.error('Error al guardar movimiento financiero:', err.message);
        return res.status(500).json({ error: 'No se pudo guardar el movimiento.' });
      }
      res.status(201).json({ id: this.lastID, message: 'Movimiento guardado.' });
    }
  );
});

app.get('/api/opiniones', (req, res) => {
  db.get(
    'SELECT COUNT(*) AS count, COALESCE(AVG(rating), 0) AS averageRating FROM service_reviews',
    [],
    (summaryError, summary) => {
      if (summaryError) {
        console.error('Error al consultar resumen de opiniones:', summaryError.message);
        return res.status(500).json({ error: 'No se pudieron consultar las opiniones.' });
      }
      db.all(
        'SELECT id, name, rating, comment, created_at AS createdAt FROM service_reviews ORDER BY id DESC LIMIT 30',
        [],
        (listError, reviews) => {
          if (listError) {
            console.error('Error al consultar opiniones:', listError.message);
            return res.status(500).json({ error: 'No se pudieron consultar las opiniones.' });
          }
          res.json({
            count: summary.count,
            averageRating: Number(summary.averageRating),
            reviews
          });
        }
      );
    }
  );
});

app.post('/api/opiniones', (req, res) => {
  const { name, rating, comment } = req.body || {};
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  const normalizedComment = typeof comment === 'string' ? comment.trim() : '';
  const numericRating = Number(rating);

  if (normalizedName.length > 40) return res.status(400).json({ error: 'El nombre debe tener máximo 40 caracteres.' });
  if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
    return res.status(400).json({ error: 'Selecciona una calificación de 1 a 5 estrellas.' });
  }
  if (!normalizedComment || normalizedComment.length > 600) {
    return res.status(400).json({ error: 'Escribe una opinión de máximo 600 caracteres.' });
  }

  const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
  const previousSubmission = reviewSubmissions.get(clientKey);
  if (previousSubmission && Date.now() - previousSubmission < 60 * 1000) {
    return res.status(429).json({ error: 'Espera un minuto antes de publicar otra opinión.' });
  }

  db.run(
    'INSERT INTO service_reviews (name, rating, comment) VALUES (?, ?, ?)',
    [normalizedName, numericRating, normalizedComment],
    function (insertError) {
      if (insertError) {
        console.error('Error al guardar opinión de servicio:', insertError.message);
        return res.status(500).json({ error: 'No se pudo publicar la opinión.' });
      }
      reviewSubmissions.set(clientKey, Date.now());
      res.status(201).json({ id: this.lastID, message: 'Opinión publicada.' });
    }
  );
});

app.get('/api/finanzas/citas', financeAuth, (req, res) => {
  const month = req.query.month || colombianMonth();
  const status = req.query.status || 'todas';
  if (!validMonth(month)) return res.status(400).json({ error: 'El mes debe tener formato YYYY-MM.' });
  if (!['todas', 'pendiente', 'confirmada', 'atendida', 'cancelada'].includes(status)) {
    return res.status(400).json({ error: 'El filtro de estado no es válido.' });
  }
  const [year, monthNumber] = month.split('-').map(Number);
  const nextMonth = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
  const statusClause = status === 'todas' ? '' : 'AND status = ?';
  const parameters = [`${month}-01`, nextMonth];
  if (status !== 'todas') parameters.push(status);

  db.all(
    `SELECT id, nombre, telefono, mensaje, appointment_date AS appointmentDate,
            appointment_time AS appointmentTime, service, status, created_at AS createdAt
     FROM citas
     WHERE (appointment_date >= ? AND appointment_date < ? OR appointment_date IS NULL) ${statusClause}
     ORDER BY appointment_date ASC, appointment_time ASC, id ASC`,
    parameters,
    (err, rows) => {
      if (err) {
        console.error('Error al consultar panel de citas:', err.message);
        return res.status(500).json({ error: 'No se pudieron consultar las citas.' });
      }

      const appointments = rows
        .map(appointmentRow)
        .filter((appointment) => !appointment.appointmentDate || appointment.appointmentDate.startsWith(month));
      res.json({ appointments });
    }
  );
});

app.post('/api/citas', (req, res) => {
  const { nombre, telefono, direccion, correo, mensaje, fecha, hora, servicio } = req.body || {};

  if (typeof nombre !== 'string' || !nombre.trim() || typeof telefono !== 'string' || !telefono.trim()) {
    return res.status(400).json({ error: 'Nombre y teléfono son obligatorios.' });
  }
  if (nombre.trim().length > 100 || telefono.trim().length > 40) {
    return res.status(400).json({ error: 'Revisa el nombre y el teléfono ingresados.' });
  }
  if (!validAppointmentTime(fecha, hora)) {
    return res.status(400).json({ error: 'Elige una fecha y hora disponibles dentro del horario de atención.' });
  }
  if (!['Corte básico', 'Corte + barba', 'Corte, diseño y textura'].includes(servicio)) {
    return res.status(400).json({ error: 'Elige un servicio válido.' });
  }
  if (typeof mensaje !== 'string' || mensaje.length > 1000) {
    return res.status(400).json({ error: 'El mensaje debe tener máximo 1000 caracteres.' });
  }

  db.run(
    `INSERT INTO citas
      (nombre, telefono, direccion, correo, mensaje, appointment_date, appointment_time, service, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente')`,
    [
      nombre.trim(),
      telefono.trim(),
      typeof direccion === 'string' ? direccion.trim() : '',
      typeof correo === 'string' ? correo.trim() : '',
      mensaje.trim(),
      fecha,
      hora,
      servicio
    ],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'No se pudo guardar la cita.' });
      }

      res.status(201).json({
        id: this.lastID,
        message: 'Cita guardada correctamente.'
      });
    }
  );
});

app.get('/api/citas', (req, res) => {
  res.status(404).json({ error: 'No se encontró ese endpoint.' });
});

app.patch('/api/finanzas/citas/:id', financeAuth, (req, res) => {
  if (!validSameOrigin(req)) return res.status(403).json({ error: 'Solicitud de origen no permitido.' });
  const appointmentId = Number(req.params.id);
  const { status } = req.body || {};
  if (!Number.isSafeInteger(appointmentId) || appointmentId <= 0) {
    return res.status(400).json({ error: 'La cita indicada no es válida.' });
  }
  if (!['pendiente', 'confirmada', 'atendida', 'cancelada'].includes(status)) {
    return res.status(400).json({ error: 'Elige un estado válido para la cita.' });
  }

  db.run('UPDATE citas SET status = ? WHERE id = ?', [status, appointmentId], function (err) {
    if (err) {
      console.error('Error al actualizar estado de la cita:', err.message);
      return res.status(500).json({ error: 'No se pudo actualizar el estado de la cita.' });
    }
    if (this.changes === 0) return res.status(404).json({ error: 'No se encontró la cita.' });
    res.json({ id: appointmentId, status, message: 'Estado de cita actualizado.' });
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
