<?php
declare(strict_types=1);

date_default_timezone_set('Asia/Manila');

const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
const MAX_ROOM_IMAGE_BYTES = 1048576;

final class ApiError extends RuntimeException
{
    public int $status;

    public function __construct(int $status, string $message)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

function database(): PDO
{
    static $pdo;
    if (!$pdo) {
        $path = __DIR__ . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'dormitory-v2.sqlite';
        $pdo = new PDO('sqlite:' . $path, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
        ]);
        $pdo->exec('PRAGMA foreign_keys = ON');
        $pdo->exec('PRAGMA busy_timeout = 5000');
        $pdo->exec("CREATE TABLE IF NOT EXISTS php_credentials (
            account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
            password_hash TEXT NOT NULL
        )");
        $pdo->exec("CREATE TABLE IF NOT EXISTS resident_notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('announcement', 'reminder')),
            source_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            read_at INTEGER,
            UNIQUE (account_id, kind, source_id)
        )");
        $pdo->exec('CREATE INDEX IF NOT EXISTS resident_notifications_unread ON resident_notifications(account_id, read_at)');
        $pdo->exec("CREATE TABLE IF NOT EXISTS login_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            address TEXT NOT NULL,
            attempted_at INTEGER NOT NULL
        )");
        $pdo->exec('CREATE INDEX IF NOT EXISTS login_attempts_lookup ON login_attempts(address, attempted_at)');
        $accountColumns = array_column($pdo->query('PRAGMA table_info(accounts)')->fetchAll(), 'name');
        if (!in_array('parent_name', $accountColumns, true)) $pdo->exec("ALTER TABLE accounts ADD COLUMN parent_name TEXT NOT NULL DEFAULT ''");
        if (!in_array('parent_phone', $accountColumns, true)) $pdo->exec("ALTER TABLE accounts ADD COLUMN parent_phone TEXT NOT NULL DEFAULT ''");
        if (!in_array('status', $accountColumns, true)) $pdo->exec("ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'Unassigned' CHECK (status IN ('Active', 'On Leave', 'Reserved', 'Moved Out', 'Unassigned'))");
        if (!in_array('move_in_date', $accountColumns, true)) $pdo->exec('ALTER TABLE accounts ADD COLUMN move_in_date TEXT');
        if (in_array('role', $accountColumns, true) && in_array('room_id', $accountColumns, true)) {
            $pdo->exec("UPDATE accounts SET status = CASE WHEN room_id IS NULL THEN 'Unassigned' ELSE 'Active' END
                , move_in_date = CASE WHEN room_id IS NULL THEN NULL ELSE COALESCE(move_in_date, date(created_at / 1000, 'unixepoch', 'localtime')) END
                WHERE role = 'resident' AND status = 'Unassigned' AND room_id IS NOT NULL");
            $pdo->exec("UPDATE accounts SET move_in_date = date(created_at / 1000, 'unixepoch', 'localtime')
                WHERE role = 'resident' AND status = 'Active' AND room_id IS NOT NULL AND move_in_date IS NULL");
            $pdo->exec("UPDATE accounts SET room_id = NULL, move_in_date = NULL WHERE role = 'resident' AND status = 'Moved Out'");
        }
        $paymentColumns = array_column($pdo->query('PRAGMA table_info(payments)')->fetchAll(), 'name');
        if (!in_array('or_number', $paymentColumns, true)) $pdo->exec("ALTER TABLE payments ADD COLUMN or_number TEXT NOT NULL DEFAULT ''");
        if (!in_array('payment_type', $paymentColumns, true)) $pdo->exec("ALTER TABLE payments ADD COLUMN payment_type TEXT NOT NULL DEFAULT 'Monthly Rent' CHECK (payment_type IN ('Reservation Fee', 'Monthly Rent', 'Damage Penalty'))");
        if (!in_array('recorded_by', $paymentColumns, true)) $pdo->exec('ALTER TABLE payments ADD COLUMN recorded_by TEXT REFERENCES accounts(id) ON DELETE SET NULL');
        if (!in_array('paid_amount', $paymentColumns, true)) $pdo->exec('ALTER TABLE payments ADD COLUMN paid_amount INTEGER CHECK (paid_amount IS NULL OR paid_amount >= 0)');
        if (!in_array('billing_frequency', $paymentColumns, true)) $pdo->exec("ALTER TABLE payments ADD COLUMN billing_frequency TEXT NOT NULL DEFAULT 'Monthly' CHECK (billing_frequency IN ('Daily', 'Weekly', 'Monthly'))");
        if (!in_array('billing_period', $paymentColumns, true)) $pdo->exec('ALTER TABLE payments ADD COLUMN billing_period TEXT');
        if (!in_array('or_image_data', $paymentColumns, true)) $pdo->exec("ALTER TABLE payments ADD COLUMN or_image_data TEXT NOT NULL DEFAULT ''");
        if (!in_array('or_verification_status', $paymentColumns, true)) $pdo->exec("ALTER TABLE payments ADD COLUMN or_verification_status TEXT NOT NULL DEFAULT 'none'");
        if (!in_array('is_security_deposit', $paymentColumns, true)) $pdo->exec('ALTER TABLE payments ADD COLUMN is_security_deposit INTEGER NOT NULL DEFAULT 0 CHECK (is_security_deposit IN (0, 1))');
        if (!in_array('or_submitted_amount', $paymentColumns, true)) $pdo->exec('ALTER TABLE payments ADD COLUMN or_submitted_amount INTEGER CHECK (or_submitted_amount IS NULL OR or_submitted_amount > 0)');
        if (!in_array('is_downpayment', $paymentColumns, true)) $pdo->exec('ALTER TABLE payments ADD COLUMN is_downpayment INTEGER NOT NULL DEFAULT 0 CHECK (is_downpayment IN (0, 1))');
        $pdo->exec("UPDATE payments SET status = 'pending', paid_amount = NULL, paid_date = NULL, recorded_by = NULL
            WHERE status = 'paid' AND or_number <> '' AND recorded_by = account_id AND or_verification_status = 'none'");
        $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS payments_billing_period ON payments(account_id, billing_period) WHERE billing_period IS NOT NULL');
        $monthlyRentStart = $pdo->prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('monthly_rent_start_month', ?)");
        $monthlyRentStart->execute([substr(today(), 0, 7)]);
        $pendingVisitors = $pdo->prepare("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE visitor_id IN (SELECT id FROM visitors WHERE status = 'pending')");
        $pendingVisitors->execute([(int) floor(microtime(true) * 1000)]);
        $pdo->exec("UPDATE visitors SET status = 'approved' WHERE status = 'pending'");
    }
    return $pdo;
}

function queryOne(string $sql, array $params = []): ?array
{
    $statement = database()->prepare($sql);
    $statement->execute($params);
    $row = $statement->fetch();
    return $row === false ? null : $row;
}

function queryAll(string $sql, array $params = []): array
{
    $statement = database()->prepare($sql);
    $statement->execute($params);
    return $statement->fetchAll();
}

function executeSql(string $sql, array $params = []): PDOStatement
{
    $statement = database()->prepare($sql);
    $statement->execute($params);
    return $statement;
}

function jsonResponse(int $status, array $data): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function reject(int $status, string $message): void
{
    throw new ApiError($status, $message);
}

function textValue($value, string $label, int $max = 100, bool $required = true): string
{
    $value = is_string($value) ? trim($value) : '';
    if ($value === '') {
        if ($required) reject(400, $label . ' is required.');
        return '';
    }
    if (mb_strlen($value) > $max) reject(400, $label . ' must be ' . $max . ' characters or fewer.');
    return $value;
}

function wholeNumber($value, string $label, int $min, int $max): int
{
    if (is_string($value) && trim($value) !== '') $value = filter_var($value, FILTER_VALIDATE_INT);
    if (!is_int($value) || $value < $min || $value > $max) {
        reject(400, $label . ' must be a whole number between ' . $min . ' and ' . $max . '.');
    }
    return $value;
}

function oneOf($value, string $label, array $choices): string
{
    if (!is_string($value) || !in_array($value, $choices, true)) {
        reject(400, $label . ' must be one of: ' . implode(', ', $choices) . '.');
    }
    return $value;
}

function validDate($value, string $label, bool $required = true): ?string
{
    if ($value === null || $value === '') {
        if ($required) reject(400, $label . ' is required.');
        return null;
    }
    if (!is_string($value)) reject(400, $label . ' must be a valid date.');
    $date = DateTimeImmutable::createFromFormat('!Y-m-d', $value);
    if (!$date || $date->format('Y-m-d') !== $value) reject(400, $label . ' must be a valid date.');
    return $value;
}

function validTime($value, string $label): string
{
    if (!is_string($value) || !preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d$/', $value)) {
        reject(400, $label . ' must be a time like 22:00.');
    }
    return $value;
}

function passwordValue($value): string
{
    if (!is_string($value) || mb_strlen($value) < PASSWORD_MIN || mb_strlen($value) > PASSWORD_MAX) {
        reject(400, 'Password must be between ' . PASSWORD_MIN . ' and ' . PASSWORD_MAX . ' characters.');
    }
    return $value;
}

function studentIdValue($value): string
{
    return accountUsernameValue($value, 'Student ID');
}

function accountUsernameValue($value, string $label): string
{
    $username = textValue($value, $label, 32);
    if (!preg_match('/^[A-Za-z0-9._-]{3,32}$/', $username)) {
        reject(400, $label . ' must be 3–32 letters, numbers, dots, dashes or underscores.');
    }
    return $username;
}

function nowMs(): int
{
    return (int) floor(microtime(true) * 1000);
}

function today(): string
{
    return date('Y-m-d');
}

function userForToken(): ?array
{
    $token = $_COOKIE['dms_session'] ?? '';
    if (!is_string($token) || $token === '') return null;
    return queryOne(
        'SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?',
        [hash('sha256', $token), nowMs()]
    );
}

function publicUser(array $user): array
{
    return [
        'id' => $user['id'],
        'username' => $user['username'],
        'studentId' => $user['role'] === 'resident' ? $user['username'] : null,
        'name' => $user['name'],
        'email' => $user['email'],
        'phone' => $user['phone'],
        'role' => $user['role'],
        'roomId' => $user['room_id'] === null ? null : (int) $user['room_id']
    ];
}

function requireAccess(string $access, ?array $user): void
{
    if ($access === 'public' || $access === 'any') return;
    if (!$user) reject(401, 'Please sign in to continue.');
    if ($access === 'admin' && $user['role'] !== 'admin') reject(403, 'Administrator access is required.');
    if ($access === 'resident' && $user['role'] !== 'resident') reject(403, 'Resident access is required.');
}

function createSession(array $user, bool $remember): void
{
    $now = nowMs();
    $maxAge = $remember ? 30 * 24 * 60 * 60 : 12 * 60 * 60;
    executeSql('DELETE FROM sessions WHERE expires_at <= ?', [$now]);
    $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    executeSql(
        'INSERT INTO sessions (token_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
        [hash('sha256', $token), $user['id'], $now + $maxAge * 1000, $now]
    );
    $base = str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/'));
    $base = $base === '/' || $base === '.' ? '/' : rtrim($base, '/') . '/';
    setcookie('dms_session', $token, [
        'expires' => $remember ? time() + $maxAge : 0,
        'path' => $base,
        'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
        'httponly' => true,
        'samesite' => 'Strict'
    ]);
}

function clearSession(): void
{
    $base = str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/'));
    $base = $base === '/' || $base === '.' ? '/' : rtrim($base, '/') . '/';
    setcookie('dms_session', '', [
        'expires' => time() - 3600,
        'path' => $base,
        'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
        'httponly' => true,
        'samesite' => 'Strict'
    ]);
}

function requireSameOrigin(): void
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $host = $_SERVER['HTTP_HOST'] ?? '';
    if (!$origin || !$host || parse_url($origin, PHP_URL_HOST) === null) reject(403, 'Request origin was not accepted.');
    $originHost = strtolower((string) parse_url($origin, PHP_URL_HOST));
    $originPort = parse_url($origin, PHP_URL_PORT);
    $requestHost = strtolower($host);
    if ($originPort !== null) $originHost .= ':' . $originPort;
    if ($originHost !== $requestHost) reject(403, 'Request origin was not accepted.');
}

function bodyData(): array
{
    $contentType = strtolower($_SERVER['CONTENT_TYPE'] ?? '');
    if (!str_starts_with($contentType, 'application/json')) reject(415, 'Send the request as JSON.');
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > 2 * 1024 * 1024) reject(413, 'Request is too large.');
    $data = json_decode($raw, true);
    if (!is_array($data) || ($data !== [] && array_keys($data) === range(0, count($data) - 1))) {
        reject(400, 'Request body must be a JSON object.');
    }
    return $data;
}

function idParam(string $value): int
{
    if (!ctype_digit($value) || (int) $value < 1) reject(404, 'Not found.');
    return (int) $value;
}

function residentSelect(): string
{
    return "SELECT a.id, a.username, a.name, a.email, a.phone, a.parent_name, a.parent_phone, a.room_id, a.status, a.move_in_date, a.created_at, r.number AS room_number
        FROM accounts a LEFT JOIN rooms r ON r.id = a.room_id";
}

function mapResident(array $r): array
{
    return [
        'id' => $r['id'], 'username' => $r['username'], 'studentId' => $r['username'],
        'name' => $r['name'], 'email' => $r['email'], 'phone' => $r['phone'],
        'parentName' => $r['parent_name'], 'parentPhone' => $r['parent_phone'],
        'roomId' => $r['room_id'] === null ? null : (int) $r['room_id'],
        'status' => $r['status'], 'moveInDate' => $r['move_in_date'],
        'roomNumber' => $r['room_number'], 'registeredAt' => (int) $r['created_at']
    ];
}

function mapAdminAccount(array $account): array
{
    $account['createdAt'] = (int) $account['createdAt'];
    return $account;
}

function loadResident(string $id): array
{
    $row = queryOne(residentSelect() . " WHERE a.role = 'resident' AND a.id = ?", [$id]);
    if (!$row) reject(404, 'Resident was not found.');
    return mapResident($row);
}

function parseRoomId($value): ?int
{
    if ($value === null || $value === '') return null;
    return wholeNumber($value, 'Room', 1, 1000000000);
}

function assertRoomOpen(?int $roomId, ?string $residentId = null): void
{
    if ($roomId === null) return;
    $room = queryOne('SELECT * FROM rooms WHERE id = ?', [$roomId]);
    if (!$room) reject(400, 'That room does not exist.');
    if ($room['status'] === 'maintenance') reject(409, 'Room ' . $room['number'] . ' is under maintenance.');
    $sql = "SELECT COUNT(*) AS n FROM accounts WHERE room_id = ? AND role = 'resident' AND status IN ('Active', 'On Leave', 'Reserved')";
    $params = [$roomId];
    if ($residentId !== null) {
        $sql .= ' AND id <> ?';
        $params[] = $residentId;
    }
    $count = (int) queryOne($sql, $params)['n'];
    if ($count >= (int) $room['capacity']) reject(409, 'Room ' . $room['number'] . ' is full.');
}

function roomOccupants(int $roomId): array
{
    return queryAll("SELECT id, name, status FROM accounts WHERE room_id = ? AND role = 'resident' AND status IN ('Active', 'On Leave', 'Reserved') ORDER BY name", [$roomId]);
}

function mapRoom(array $room, array $occupants): array
{
    $list = array_map(static fn(array $o): array => ['id' => $o['id'], 'name' => $o['name']], $occupants);
    return [
        'id' => (int) $room['id'],
        'number' => $room['number'],
        'capacity' => (int) $room['capacity'],
        'rent' => (int) $room['rent'],
        'notes' => $room['notes'],
        'photoData' => $room['photo_data'],
        'maintenance' => $room['status'] === 'maintenance',
        'occupants' => $list,
        'availableBeds' => max(0, (int) $room['capacity'] - count($list)),
        'status' => $room['status'] === 'maintenance' ? 'maintenance' : (count($list) >= (int) $room['capacity'] ? 'occupied' : 'available')
    ];
}

function loadRoom(int $id): array
{
    $room = queryOne('SELECT * FROM rooms WHERE id = ?', [$id]);
    if (!$room) reject(404, 'Room was not found.');
    return mapRoom($room, roomOccupants($id));
}

function roomPayload(array $body, array $current = []): array
{
    $number = array_key_exists('number', $body) || !$current ? textValue($body['number'] ?? '', 'Room number', 20) : $current['number'];
    $capacity = array_key_exists('capacity', $body) || !$current ? wholeNumber($body['capacity'] ?? null, 'Capacity', 1, 20) : $current['capacity'];
    $rent = array_key_exists('rent', $body) || !$current ? wholeNumber($body['rent'] ?? 0, 'Rent', 0, 10000000) : $current['rent'];
    $status = array_key_exists('status', $body) || !$current ? oneOf($body['status'] ?? 'available', 'Status', ['available', 'maintenance']) : $current['status'];
    $notes = array_key_exists('notes', $body) ? textValue($body['notes'], 'Notes', 200, false) : ($current['notes'] ?? '');
    $photo = array_key_exists('photoData', $body) ? roomPhoto($body['photoData'], true) : ($current['photoData'] ?? '');
    return compact('number', 'capacity', 'rent', 'status', 'notes', 'photo');
}

function roomPhoto($value, bool $optional = false): string
{
    return imageData($value, 'Room photo', $optional);
}

function paymentProofImage($value): string
{
    return imageData($value, 'Payment proof', true);
}

function imageData($value, string $label, bool $optional = false): string
{
    if ($optional && ($value === null || $value === '')) return '';
    $invalidMessage = $label . ' must be a PNG, JPEG or WebP image no larger than 1 MB.';
    if (!is_string($value) || !preg_match('/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+\/]+={0,2})$/', $value, $match)) {
        reject(400, $invalidMessage);
    }
    $bytes = base64_decode($match[2], true);
    if ($bytes === false || strlen($bytes) > MAX_ROOM_IMAGE_BYTES || base64_encode($bytes) !== $match[2]) {
        reject(400, $invalidMessage);
    }
    $valid = match ($match[1]) {
        'png' => str_starts_with($bytes, "\x89PNG\r\n\x1a\n"),
        'jpeg' => strlen($bytes) >= 3 && substr($bytes, 0, 3) === "\xff\xd8\xff",
        'webp' => strlen($bytes) >= 12 && substr($bytes, 0, 4) === 'RIFF' && substr($bytes, 8, 4) === 'WEBP'
    };
    if (!$valid) reject(400, $label . ' contents do not match the selected image type.');
    return $value;
}

function curfewTime(): string
{
    return queryOne("SELECT value FROM settings WHERE key = 'curfew_time'")['value'];
}

function paymentSelect(): string
{
    return "SELECT p.id, p.account_id, p.amount, p.due_date, p.paid_date, p.note, p.or_number, p.payment_type, p.billing_frequency,
        p.is_security_deposit, p.is_downpayment, p.or_submitted_amount,
        p.or_verification_status, CASE WHEN p.or_image_data <> '' THEN 1 ELSE 0 END AS has_or_image,
        CASE WHEN p.status = 'pending' AND p.due_date < ? THEN 'overdue' ELSE p.status END AS shown_status,
        a.name AS resident_name, r.number AS room_number
        FROM payments p JOIN accounts a ON a.id = p.account_id
        LEFT JOIN rooms r ON r.id = a.room_id";
}

function ensureMonthlyRentPayments(): void
{
    $today = today();
    $currentMonth = substr($today, 0, 7);
    $start = queryOne("SELECT value FROM settings WHERE key = 'monthly_rent_start_month'");
    $startMonth = $start['value'] ?? '';
    if (!preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $startMonth)) {
        throw new RuntimeException('Monthly rent billing start month is invalid.');
    }
    if ($startMonth > $currentMonth) return;

    $pdo = database();
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $residents = queryAll("SELECT a.id, a.move_in_date, r.rent
            FROM accounts a JOIN rooms r ON r.id = a.room_id
            WHERE a.role = 'resident' AND a.status IN ('Active', 'On Leave')
                AND a.move_in_date IS NOT NULL AND a.move_in_date <= ? AND r.rent > 0", [$today]);
        $month = $startMonth;
        while ($month <= $currentMonth) {
            $monthStart = new DateTimeImmutable($month . '-01');
            $lastDay = (int) $monthStart->modify('last day of this month')->format('d');
            foreach ($residents as $resident) {
                if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $resident['move_in_date'])) {
                    throw new RuntimeException('A resident has an invalid move-in date.');
                }
                if (substr($resident['move_in_date'], 0, 7) > $month) continue;

                $exists = queryOne("SELECT id FROM payments
                    WHERE account_id = ? AND (
                        billing_period = ? OR
                        (payment_type = 'Monthly Rent' AND billing_frequency = 'Monthly' AND substr(due_date, 1, 7) = ?)
                    ) LIMIT 1", [$resident['id'], $month, $month]);
                if ($exists) continue;

                $moveInDay = (int) substr($resident['move_in_date'], 8, 2);
                $dueDate = $month . '-' . str_pad((string) min($moveInDay, $lastDay), 2, '0', STR_PAD_LEFT);
                executeSql("INSERT INTO payments
                    (account_id, amount, paid_amount, status, due_date, paid_date, note, or_number,
                     payment_type, billing_frequency, billing_period, recorded_by, created_at)
                    VALUES (?, ?, NULL, 'pending', ?, NULL, ?, '', 'Monthly Rent', 'Monthly', ?, NULL, ?)",
                    [$resident['id'], (int) $resident['rent'], $dueDate, 'Monthly rent for ' . $month, $month, nowMs()]);
            }
            $month = $monthStart->modify('first day of next month')->format('Y-m');
        }
        $pdo->exec('COMMIT');
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $error;
    }
}

function mapPayment(array $p): array
{
    return [
        'id' => (int) $p['id'], 'accountId' => $p['account_id'], 'residentName' => $p['resident_name'],
        'roomNumber' => $p['room_number'], 'amount' => (int) $p['amount'], 'status' => $p['shown_status'],
        'dueDate' => $p['due_date'], 'paidDate' => $p['paid_date'], 'note' => $p['note'], 'orNumber' => $p['or_number'],
        'paymentType' => (int) $p['is_security_deposit'] === 1 ? 'Security Deposit' : ((int) $p['is_downpayment'] === 1 ? 'Downpayment' : $p['payment_type']),
        'isSecurityDeposit' => (bool) $p['is_security_deposit'], 'isDownpayment' => (bool) $p['is_downpayment'], 'billingFrequency' => $p['billing_frequency'],
        'verificationStatus' => $p['or_verification_status'], 'submittedAmount' => $p['or_submitted_amount'],
        'hasOrImage' => (bool) $p['has_or_image']
    ];
}

function loadPayment(int $id): array
{
    $row = queryOne(paymentSelect() . ' WHERE p.id = ?', [today(), $id]);
    if (!$row) reject(404, 'Payment was not found.');
    return mapPayment($row);
}

function visitorSelect(): string
{
    return "SELECT v.id, v.visitor_name AS visitorName, v.visited_at AS visitedAt, v.status,
        a.name AS residentName, r.number AS roomNumber
        FROM visitors v JOIN accounts a ON a.id = v.account_id
        LEFT JOIN rooms r ON r.id = a.room_id";
}

function responseCreated(array $data): never
{
    jsonResponse(201, $data);
}

function appBasePath(): string
{
    $path = str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/'));
    return $path === '/' || $path === '.' ? '' : rtrim($path, '/');
}

function apiPath(): string
{
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    $base = appBasePath();
    if ($base !== '' && str_starts_with($path, $base . '/')) $path = substr($path, strlen($base));
    return $path;
}

try {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $path = apiPath();
    $routes = [
        ['GET', '#^/api/auth/me$#', 'any', 'auth-me'],
        ['POST', '#^/api/auth/login$#', 'public', 'auth-login'],
        ['POST', '#^/api/auth/logout$#', 'public', 'auth-logout'],
        ['POST', '#^/api/auth/register$#', 'public', 'auth-register'],
        ['GET', '#^/api/admin/residents$#', 'admin', 'residents-list'],
        ['GET', '#^/api/admin/residents/unassigned$#', 'admin', 'residents-unassigned'],
        ['POST', '#^/api/admin/residents$#', 'admin', 'residents-create'],
        ['PATCH', '#^/api/admin/residents/([^/]+)$#', 'admin', 'residents-update'],
        ['DELETE', '#^/api/admin/residents/([^/]+)$#', 'admin', 'residents-delete'],
        ['GET', '#^/api/admin/rooms/(\d+)/residents$#', 'admin', 'room-residents'],
        ['POST', '#^/api/admin/rooms/(\d+)/assign$#', 'admin', 'room-assign'],
        ['POST', '#^/api/admin/residents/([^/]+)/transfer$#', 'admin', 'resident-transfer'],
        ['PATCH', '#^/api/admin/residents/([^/]+)/status$#', 'admin', 'resident-status'],
        ['POST', '#^/api/admin/residents/([^/]+)/move-out$#', 'admin', 'resident-move-out'],
        ['GET', '#^/api/admin/accounts$#', 'admin', 'accounts-list'],
        ['POST', '#^/api/admin/accounts$#', 'admin', 'accounts-create'],
        ['PATCH', '#^/api/admin/accounts/([^/]+)$#', 'admin', 'accounts-update'],
        ['GET', '#^/api/admin/rooms$#', 'admin', 'rooms-list'],
        ['POST', '#^/api/admin/rooms$#', 'admin', 'rooms-create'],
        ['PATCH', '#^/api/admin/rooms/([^/]+)$#', 'admin', 'rooms-update'],
        ['DELETE', '#^/api/admin/rooms/([^/]+)$#', 'admin', 'rooms-delete'],
        ['GET', '#^/api/admin/payments$#', 'admin', 'payments-list'],
        ['GET', '#^/api/payments/history$#', 'admin', 'payments-history'],
        ['GET', '#^/api/admin/payments/(\d+)/proof$#', 'admin', 'payments-proof'],
        ['PATCH', '#^/api/admin/payments/(\d+)/verification$#', 'admin', 'payments-verification'],
        ['PUT', '#^/api/payments/record$#', 'admin', 'payments-record'],
        ['POST', '#^/api/me/payments/monthly$#', 'resident', 'resident-payment-monthly'],
        ['POST', '#^/api/me/payments/advance$#', 'resident', 'resident-payment-advance'],
        ['POST', '#^/api/me/payments/deposit$#', 'resident', 'resident-payment-deposit'],
        ['POST', '#^/api/me/payments/(\d+)/or$#', 'resident', 'resident-payment-or'],
        ['PATCH', '#^/api/me/payments/(\d+)/or$#', 'resident', 'resident-payment-or-update'],
        ['POST', '#^/api/admin/payments$#', 'admin', 'payments-create'],
        ['PATCH', '#^/api/admin/payments/([^/]+)$#', 'admin', 'payments-update'],
        ['DELETE', '#^/api/admin/payments/([^/]+)$#', 'admin', 'payments-delete'],
        ['GET', '#^/api/admin/summary$#', 'admin', 'summary'],
        ['GET', '#^/api/announcements$#', 'any', 'announcements-list'],
        ['POST', '#^/api/admin/announcements$#', 'admin', 'announcements-create'],
        ['DELETE', '#^/api/admin/announcements/([^/]+)$#', 'admin', 'announcements-delete'],
        ['GET', '#^/api/reminders$#', 'any', 'reminders-list'],
        ['POST', '#^/api/admin/reminders$#', 'admin', 'reminders-create'],
        ['DELETE', '#^/api/admin/reminders/([^/]+)$#', 'admin', 'reminders-delete'],
        ['GET', '#^/api/admin/visitors$#', 'admin', 'visitors-list'],
        ['POST', '#^/api/admin/visitors$#', 'admin', 'visitors-create'],
        ['POST', '#^/api/admin/visitors/([^/]+)/approve$#', 'admin', 'visitors-approve'],
        ['DELETE', '#^/api/admin/visitors/([^/]+)$#', 'admin', 'visitors-delete'],
        ['GET', '#^/api/admin/notifications$#', 'admin', 'notifications-list'],
        ['PATCH', '#^/api/admin/notifications/([^/]+)$#', 'admin', 'notifications-read'],
        ['GET', '#^/api/me/notifications$#', 'resident', 'resident-notifications-list'],
        ['PATCH', '#^/api/me/notifications/([^/]+)$#', 'resident', 'resident-notifications-read'],
        ['GET', '#^/api/admin/curfew$#', 'admin', 'curfew-admin'],
        ['PATCH', '#^/api/admin/curfew$#', 'admin', 'curfew-update'],
        ['GET', '#^/api/me/overview$#', 'resident', 'overview'],
        ['POST', '#^/api/me/visitors$#', 'resident', 'visitor-submit']
    ];
    $route = null;
    $params = [];
    $pathMatched = false;
    foreach ($routes as $candidate) {
        if (preg_match($candidate[1], $path, $matches)) {
            $pathMatched = true;
            $params = array_slice($matches, 1);
            if ($candidate[0] === $method) {
                $route = $candidate;
                break;
            }
        }
    }
    if (!$route) reject($pathMatched ? 405 : 404, $pathMatched ? 'Method not allowed.' : 'Not found.');
    if ($method !== 'GET') requireSameOrigin();
    $user = userForToken();
    requireAccess($route[2], $user);
    $body = in_array($method, ['POST', 'PATCH', 'PUT'], true) ? bodyData() : [];
    $param = $params[0] ?? '';

    switch ($route[3]) {
        case 'auth-me':
            jsonResponse(200, ['user' => $user ? publicUser($user) : null]);
        case 'auth-login':
            $address = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
            executeSql('DELETE FROM login_attempts WHERE attempted_at <= ?', [nowMs() - 15 * 60 * 1000]);
            $attempts = (int) queryOne('SELECT COUNT(*) AS n FROM login_attempts WHERE address = ?', [$address])['n'];
            if ($attempts >= 10) reject(429, 'Too many sign-in attempts. Please wait a few minutes and try again.');
            $identifier = $body['username'] ?? '';
            $identifier = is_string($identifier) ? trim($identifier) : '';
            $password = $body['password'] ?? '';
            if ($identifier === '' || strlen($identifier) > 64 ||
                !is_string($password) || $password === '' || mb_strlen($password) > PASSWORD_MAX) {
                reject(400, 'Enter your username and password.');
            }
            $account = queryOne('SELECT * FROM accounts WHERE username = ? COLLATE NOCASE', [$identifier]);
            $credential = $account ? queryOne('SELECT password_hash FROM php_credentials WHERE account_id = ?', [$account['id']]) : null;
            if (!$account || !in_array($account['role'] ?? null, ['admin', 'resident'], true) || !$credential ||
                !password_verify($password, $credential['password_hash'])) {
                executeSql('INSERT INTO login_attempts (address, attempted_at) VALUES (?, ?)', [$address, nowMs()]);
                reject(401, 'Incorrect username or password.');
            }
            executeSql('DELETE FROM login_attempts WHERE address = ?', [$address]);
            createSession($account, !empty($body['remember']));
            jsonResponse(200, ['user' => publicUser($account)]);
        case 'auth-logout':
            $token = $_COOKIE['dms_session'] ?? '';
            if (is_string($token) && $token !== '') executeSql('DELETE FROM sessions WHERE token_hash = ?', [hash('sha256', $token)]);
            clearSession();
            jsonResponse(200, ['ok' => true]);
        case 'auth-register':
            reject(403, 'Resident registration is closed. Please contact the administrator.');
        case 'residents-list':
            $rows = queryAll(residentSelect() . " WHERE a.role = 'resident' ORDER BY a.created_at DESC");
            jsonResponse(200, ['residents' => array_map('mapResident', $rows)]);
        case 'residents-unassigned':
            $rows = queryAll(residentSelect() . " WHERE a.role = 'resident' AND a.status = 'Unassigned' AND a.room_id IS NULL ORDER BY a.name COLLATE NOCASE");
            jsonResponse(200, ['residents' => array_map('mapResident', $rows)]);
        case 'residents-create':
            $name = textValue($body['name'] ?? '', 'Name');
            $studentId = studentIdValue($body['username'] ?? $body['studentId'] ?? '');
            $email = textValue($body['email'] ?? '', 'Email', 254);
            $phone = textValue($body['phone'] ?? '', 'Phone', 40);
            $parentName = textValue($body['parentName'] ?? '', 'Parent/Guardian name', 100);
            $parentPhone = textValue($body['parentPhone'] ?? '', 'Parent/Guardian phone', 40);
            $password = passwordValue($body['password'] ?? null);
            $roomId = parseRoomId($body['roomId'] ?? null);
            if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) reject(400, 'Enter a valid email address.');
            assertRoomOpen($roomId);
            $id = bin2hex(random_bytes(16));
            try {
                database()->beginTransaction();
                executeSql("INSERT INTO accounts (id, username, name, email, phone, parent_name, parent_phone, role, room_id, status, move_in_date, password_salt, password_hash, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'resident', ?, ?, ?, '', '', ?)",
                    [$id, $studentId, $name, $email, $phone, $parentName, $parentPhone, $roomId,
                        $roomId === null ? 'Unassigned' : 'Active', $roomId === null ? null : today(), nowMs()]);
                executeSql('INSERT INTO php_credentials (account_id, password_hash) VALUES (?, ?)', [$id, password_hash($password, PASSWORD_DEFAULT)]);
                database()->commit();
            } catch (Throwable $error) {
                if (database()->inTransaction()) database()->rollBack();
                if (str_contains($error->getMessage(), 'accounts.username')) reject(409, 'That Student ID is already taken.');
                throw $error;
            }
            responseCreated(['resident' => loadResident($id)]);
        case 'residents-update':
            $id = $param;
            $current = loadResident($id);
            $name = array_key_exists('name', $body) ? textValue($body['name'], 'Name') : $current['name'];
            $email = array_key_exists('email', $body) ? textValue($body['email'], 'Email', 254) : $current['email'];
            $phone = array_key_exists('phone', $body) ? textValue($body['phone'], 'Phone', 40) : $current['phone'];
            $parentName = array_key_exists('parentName', $body) ? textValue($body['parentName'], 'Parent/Guardian name', 100) : $current['parentName'];
            $parentPhone = array_key_exists('parentPhone', $body) ? textValue($body['parentPhone'], 'Parent/Guardian phone', 40) : $current['parentPhone'];
            $roomId = array_key_exists('roomId', $body) ? parseRoomId($body['roomId']) : $current['roomId'];
            if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) reject(400, 'Enter a valid email address.');
            if ($roomId !== $current['roomId']) assertRoomOpen($roomId, $id);
            $newPassword = isset($body['password']) && $body['password'] !== '' ? passwordValue($body['password']) : null;
            $status = $roomId !== $current['roomId']
                ? ($roomId === null ? 'Unassigned' : 'Active')
                : $current['status'];
            $moveInDate = $roomId !== $current['roomId']
                ? ($roomId === null ? null : today())
                : $current['moveInDate'];
            executeSql('UPDATE accounts SET name = ?, email = ?, phone = ?, parent_name = ?, parent_phone = ?, room_id = ?, status = ?, move_in_date = ? WHERE id = ?',
                [$name, $email, $phone, $parentName, $parentPhone, $roomId, $status, $moveInDate, $id]);
            if ($newPassword !== null) executeSql('INSERT INTO php_credentials (account_id, password_hash) VALUES (?, ?)
                ON CONFLICT(account_id) DO UPDATE SET password_hash = excluded.password_hash', [$id, password_hash($newPassword, PASSWORD_DEFAULT)]);
            jsonResponse(200, ['resident' => loadResident($id)]);
        case 'residents-delete':
            $result = executeSql("DELETE FROM accounts WHERE id = ? AND role = 'resident'", [$param]);
            if (!$result->rowCount()) reject(404, 'Resident was not found.');
            jsonResponse(200, ['ok' => true]);
        case 'accounts-list':
            $accounts = queryAll("SELECT id, username, name, email, phone, created_at AS createdAt
                FROM accounts WHERE role = 'admin' ORDER BY created_at ASC, username COLLATE NOCASE");
            jsonResponse(200, ['accounts' => array_map('mapAdminAccount', $accounts)]);
        case 'accounts-create':
            $username = accountUsernameValue($body['username'] ?? '', 'Username');
            $name = textValue($body['name'] ?? '', 'Name');
            $email = textValue($body['email'] ?? '', 'Email', 254);
            $phone = textValue($body['phone'] ?? '', 'Phone', 40, false);
            $password = passwordValue($body['password'] ?? null);
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) reject(400, 'Enter a valid email address.');
            $id = bin2hex(random_bytes(16));
            try {
                database()->beginTransaction();
                executeSql("INSERT INTO accounts (id, username, name, email, phone, role, room_id, password_salt, password_hash, created_at)
                    VALUES (?, ?, ?, ?, ?, 'admin', NULL, '', '', ?)", [$id, $username, $name, $email, $phone, nowMs()]);
                executeSql('INSERT INTO php_credentials (account_id, password_hash) VALUES (?, ?)', [$id, password_hash($password, PASSWORD_DEFAULT)]);
                database()->commit();
            } catch (Throwable $error) {
                if (database()->inTransaction()) database()->rollBack();
                if (str_contains($error->getMessage(), 'accounts.username')) reject(409, 'That username is already taken.');
                throw $error;
            }
            responseCreated(['account' => mapAdminAccount(queryOne("SELECT id, username, name, email, phone, created_at AS createdAt
                FROM accounts WHERE id = ? AND role = 'admin'", [$id]))]);
        case 'accounts-update':
            $current = queryOne("SELECT id, username, name, email, phone, created_at AS createdAt
                FROM accounts WHERE id = ? AND role = 'admin'", [$param]);
            if (!$current) reject(404, 'Admin account was not found.');
            $username = array_key_exists('username', $body) ? accountUsernameValue($body['username'], 'Username') : $current['username'];
            $name = array_key_exists('name', $body) ? textValue($body['name'], 'Name') : $current['name'];
            $email = array_key_exists('email', $body) ? textValue($body['email'], 'Email', 254) : textValue($current['email'], 'Email', 254);
            $phone = array_key_exists('phone', $body) ? textValue($body['phone'], 'Phone', 40, false) : $current['phone'];
            $newPassword = isset($body['password']) && $body['password'] !== '' ? passwordValue($body['password']) : null;
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) reject(400, 'Enter a valid email address.');
            try {
                executeSql('UPDATE accounts SET username = ?, name = ?, email = ?, phone = ? WHERE id = ? AND role = \'admin\'',
                    [$username, $name, $email, $phone, $param]);
                if ($newPassword !== null) executeSql('INSERT INTO php_credentials (account_id, password_hash) VALUES (?, ?)
                    ON CONFLICT(account_id) DO UPDATE SET password_hash = excluded.password_hash', [$param, password_hash($newPassword, PASSWORD_DEFAULT)]);
            } catch (PDOException $error) {
                if (str_contains($error->getMessage(), 'accounts.username')) reject(409, 'That username is already taken.');
                throw $error;
            }
            jsonResponse(200, ['account' => mapAdminAccount(queryOne("SELECT id, username, name, email, phone, created_at AS createdAt
                FROM accounts WHERE id = ? AND role = 'admin'", [$param]))]);
        case 'rooms-list':
            $rooms = [];
            foreach (queryAll('SELECT * FROM rooms ORDER BY number COLLATE NOCASE') as $room) {
                $rooms[] = mapRoom($room, roomOccupants((int) $room['id']));
            }
            jsonResponse(200, ['rooms' => $rooms]);
        case 'room-residents':
            $roomId = idParam($param);
            $room = queryOne('SELECT id, number FROM rooms WHERE id = ?', [$roomId]);
            if (!$room) reject(404, 'Room was not found.');
            $residents = queryAll(residentSelect() . " WHERE a.role = 'resident' AND a.room_id = ?
                AND a.status IN ('Active', 'On Leave', 'Reserved') ORDER BY a.name COLLATE NOCASE", [$roomId]);
            $residents = array_map(static function (array $resident): array {
                $mapped = mapResident($resident);
                $mapped['contactInfo'] = implode(' · ', array_filter([$resident['phone'], $resident['email']], static fn($value): bool => $value !== ''));
                return $mapped;
            }, $residents);
            jsonResponse(200, ['room' => ['id' => (int) $room['id'], 'number' => $room['number']], 'residents' => $residents]);
        case 'room-assign':
            $roomId = idParam($param);
            $residentId = textValue($body['residentId'] ?? '', 'Resident', 64);
            $reservationOnly = ($body['reservationOnly'] ?? false) === true;
            try {
                database()->beginTransaction();
                $resident = queryOne("SELECT id, room_id, status FROM accounts WHERE id = ? AND role = 'resident'", [$residentId]);
                if (!$resident || $resident['status'] !== 'Unassigned' || $resident['room_id'] !== null) reject(409, 'Choose an unassigned resident.');
                assertRoomOpen($roomId, $residentId);
                $room = queryOne('SELECT id, number, rent FROM rooms WHERE id = ?', [$roomId]);
                $status = $reservationOnly ? 'Reserved' : 'Active';
                executeSql('UPDATE accounts SET room_id = ?, status = ?, move_in_date = ? WHERE id = ?',
                    [$roomId, $status, $reservationOnly ? null : today(), $residentId]);
                $payment = null;
                if ($reservationOnly) {
                    if ((int) $room['rent'] < 1) reject(409, 'Set a monthly rent for Room ' . $room['number'] . ' before reserving a bed.');
                    $dueDate = today();
                    executeSql("INSERT INTO payments (account_id, amount, status, due_date, paid_date, note, or_number, payment_type, created_at)
                        VALUES (?, ?, 'pending', ?, NULL, ?, '', 'Reservation Fee', ?)",
                        [$residentId, (int) $room['rent'], $dueDate, 'Reservation fee for Room ' . $room['number'], nowMs()]);
                    $payment = ['id' => (int) database()->lastInsertId(), 'amount' => (int) $room['rent'],
                        'dueDate' => $dueDate, 'status' => 'pending', 'paymentType' => 'Reservation Fee'];
                }
                database()->commit();
            } catch (Throwable $error) {
                if (database()->inTransaction()) database()->rollBack();
                throw $error;
            }
            responseCreated(['resident' => loadResident($residentId), 'payment' => $payment]);
        case 'resident-transfer':
            $residentId = $param;
            $roomId = parseRoomId($body['roomId'] ?? null);
            if ($roomId === null) reject(400, 'Choose a room.');
            try {
                database()->beginTransaction();
                $resident = queryOne("SELECT id, room_id, status FROM accounts WHERE id = ? AND role = 'resident'", [$residentId]);
                if (!$resident || !in_array($resident['status'], ['Active', 'On Leave', 'Reserved'], true) || $resident['room_id'] === null) {
                    reject(409, 'This resident cannot be transferred.');
                }
                if ((int) $resident['room_id'] === $roomId) reject(400, 'Choose a different room.');
                assertRoomOpen($roomId, $residentId);
                executeSql("UPDATE accounts SET room_id = ?, move_in_date = CASE WHEN status = 'Active' THEN ? ELSE move_in_date END WHERE id = ?",
                    [$roomId, today(), $residentId]);
                database()->commit();
            } catch (Throwable $error) {
                if (database()->inTransaction()) database()->rollBack();
                throw $error;
            }
            jsonResponse(200, ['resident' => loadResident($residentId)]);
        case 'resident-status':
            $status = oneOf($body['status'] ?? null, 'Status', ['Active', 'On Leave']);
            $result = executeSql("UPDATE accounts SET status = ?,
                move_in_date = CASE WHEN ? = 'Active' THEN COALESCE(move_in_date, ?) ELSE move_in_date END
                WHERE id = ? AND role = 'resident' AND room_id IS NOT NULL
                AND (status IN ('Active', 'On Leave') OR (status = 'Reserved' AND ? = 'Active'))",
                [$status, $status, today(), $param, $status]);
            if (!$result->rowCount()) reject(409, 'This resident cannot make that status change.');
            jsonResponse(200, ['resident' => loadResident($param)]);
        case 'resident-move-out':
            ensureMonthlyRentPayments();
            try {
                database()->beginTransaction();
                if (!queryOne("SELECT id FROM accounts WHERE id = ? AND role = 'resident'", [$param])) reject(404, 'Resident was not found.');
                $balance = (int) queryOne("SELECT COUNT(*) AS n FROM payments WHERE account_id = ? AND status IN ('pending', 'overdue')", [$param])['n'];
                if ($balance > 0) reject(409, 'Move-out is blocked. Clear all pending or overdue payments first.');
                executeSql("UPDATE accounts SET room_id = NULL, status = 'Moved Out', move_in_date = NULL WHERE id = ?", [$param]);
                database()->commit();
            } catch (Throwable $error) {
                if (database()->inTransaction()) database()->rollBack();
                throw $error;
            }
            jsonResponse(200, ['resident' => loadResident($param)]);
        case 'rooms-create':
            $room = roomPayload($body);
            try {
                executeSql('INSERT INTO rooms (number, capacity, rent, status, notes, photo_data) VALUES (?, ?, ?, ?, ?, ?)',
                    [$room['number'], $room['capacity'], $room['rent'], $room['status'], $room['notes'], $room['photo']]);
            } catch (PDOException $error) {
                if (str_contains($error->getMessage(), 'rooms.number')) reject(409, 'A room with that number already exists.');
                throw $error;
            }
            responseCreated(['room' => loadRoom((int) database()->lastInsertId())]);
        case 'rooms-update':
            $id = idParam($param);
            $current = loadRoom($id);
            $room = roomPayload($body, [
                'number' => $current['number'], 'capacity' => $current['capacity'], 'rent' => $current['rent'],
                'status' => $current['maintenance'] ? 'maintenance' : 'available', 'notes' => $current['notes'],
                'photoData' => $current['photoData']
            ]);
            if ($room['capacity'] < count($current['occupants'])) reject(409, 'Room ' . $current['number'] . ' has ' . count($current['occupants']) . ' residents; capacity cannot be lower.');
            try {
                executeSql('UPDATE rooms SET number = ?, capacity = ?, rent = ?, status = ?, notes = ?, photo_data = ? WHERE id = ?',
                    [$room['number'], $room['capacity'], $room['rent'], $room['status'], $room['notes'], $room['photo'], $id]);
            } catch (PDOException $error) {
                if (str_contains($error->getMessage(), 'rooms.number')) reject(409, 'A room with that number already exists.');
                throw $error;
            }
            jsonResponse(200, ['room' => loadRoom($id)]);
        case 'rooms-delete':
            $result = executeSql('DELETE FROM rooms WHERE id = ?', [idParam($param)]);
            if (!$result->rowCount()) reject(404, 'Room was not found.');
            jsonResponse(200, ['ok' => true]);
        case 'payments-list':
            ensureMonthlyRentPayments();
            $rows = queryAll(paymentSelect() . ' ORDER BY p.due_date DESC, p.id DESC', [today()]);
            jsonResponse(200, ['payments' => array_map('mapPayment', $rows)]);
        case 'payments-history':
            $rows = queryAll("SELECT p.id, COALESCE(p.paid_amount, p.amount) AS amount, p.paid_date AS paidDate, p.or_number AS orNumber,
                CASE WHEN p.is_security_deposit = 1 THEN 'Security Deposit'
                    WHEN p.is_downpayment = 1 THEN 'Downpayment' ELSE p.payment_type END AS paymentType,
                p.billing_frequency AS billingFrequency,
                a.name AS residentName, r.number AS roomNumber,
                recorder.name AS recordedBy
                FROM payments p
                JOIN accounts a ON a.id = p.account_id
                LEFT JOIN rooms r ON r.id = a.room_id
                LEFT JOIN accounts recorder ON recorder.id = p.recorded_by
                WHERE p.status = 'paid'
                ORDER BY p.paid_date DESC, p.id DESC");
            jsonResponse(200, ['payments' => $rows]);
        case 'payments-proof':
            $proof = queryOne('SELECT or_image_data FROM payments WHERE id = ?', [idParam($param)]);
            if (!$proof) reject(404, 'Payment was not found.');
            jsonResponse(200, ['orImageData' => $proof['or_image_data']]);
        case 'payments-verification':
            $id = idParam($param);
            $decision = oneOf($body['decision'] ?? null, 'Verification decision', ['verified', 'rejected']);
            $pdo = database();
            $pdo->beginTransaction();
            try {
                $payment = queryOne('SELECT * FROM payments WHERE id = ?', [$id]);
                if (!$payment) reject(404, 'Payment was not found.');
                if ($payment['or_number'] === '' || $payment['or_verification_status'] !== 'pending' || $payment['status'] === 'paid') {
                    reject(409, 'This payment is not awaiting OR verification.');
                }
                if ($decision === 'verified') {
                    $submittedAmount = (int) ($payment['or_submitted_amount'] ?: $payment['amount']);
                    if ($submittedAmount < (int) $payment['amount']) {
                        executeSql("INSERT INTO payments
                            (account_id, amount, paid_amount, status, due_date, paid_date, note, or_number, payment_type,
                             is_security_deposit, is_downpayment, billing_frequency, or_image_data, or_verification_status, recorded_by, created_at)
                            VALUES (?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?)",
                            [$payment['account_id'], $submittedAmount, $submittedAmount, $payment['due_date'], today(),
                                ($payment['note'] ?: $payment['payment_type']) . ' · Partial payment', $payment['or_number'],
                                $payment['payment_type'], $payment['is_security_deposit'], $payment['is_downpayment'], $payment['billing_frequency'],
                                $payment['or_image_data'], $user['id'], nowMs()]);
                        executeSql("UPDATE payments SET amount = ?, or_number = '', or_image_data = '',
                            or_verification_status = 'none', or_submitted_amount = NULL WHERE id = ?",
                            [(int) $payment['amount'] - $submittedAmount, $id]);
                    } else {
                        executeSql("UPDATE payments SET status = 'paid', paid_amount = amount, paid_date = ?,
                            recorded_by = ?, or_verification_status = 'verified', or_submitted_amount = NULL WHERE id = ?",
                            [today(), $user['id'], $id]);
                    }
                } else {
                    executeSql("UPDATE payments SET or_verification_status = 'rejected' WHERE id = ?", [$id]);
                }
                $pdo->commit();
            } catch (Throwable $error) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                throw $error;
            }
            jsonResponse(200, ['payment' => loadPayment($id)]);
        case 'payments-record':
            $id = idParam((string) ($body['payment_id'] ?? ''));
            $orNumber = textValue($body['or_number'] ?? '', 'OR number', 64);
            $amountPaid = wholeNumber($body['amount_paid'] ?? null, 'Amount paid', 1, 100000000);
            $pdo = database();
            $pdo->beginTransaction();
            try {
                $payment = queryOne('SELECT id, amount, status FROM payments WHERE id = ?', [$id]);
                if (!$payment) reject(404, 'Payment was not found.');
                if ($payment['status'] === 'paid') reject(409, 'This payment has already been recorded.');
                if ($amountPaid < (int) $payment['amount']) reject(422, 'Amount paid cannot be less than the dorm payment.');
                if (queryOne('SELECT id FROM payments WHERE lower(trim(or_number)) = lower(?) AND id != ?', [$orNumber, $id])) {
                    reject(422, 'This OR number has already been used.');
                }
                executeSql("UPDATE payments SET paid_amount = ?, status = 'paid', paid_date = ?, or_number = ?, recorded_by = ? WHERE id = ?",
                    [$amountPaid, today(), $orNumber, $user['id'], $id]);
                $pdo->commit();
            } catch (Throwable $error) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                throw $error;
            }
            jsonResponse(200, ['payment' => loadPayment($id)]);
        case 'payments-create':
            $accountId = textValue($body['accountId'] ?? '', 'Resident', 64);
            if (!queryOne("SELECT 1 FROM accounts WHERE id = ? AND role = 'resident'", [$accountId])) reject(400, 'Choose a valid resident.');
            $amount = wholeNumber($body['amount'] ?? null, 'Amount', 1, 100000000);
            $status = oneOf($body['status'] ?? 'pending', 'Status', ['paid', 'pending', 'overdue']);
            $dueDate = validDate($body['dueDate'] ?? null, 'Due date');
            $note = textValue($body['note'] ?? '', 'Note', 200, false);
            $orNumber = textValue($body['orNumber'] ?? '', 'OR number', 64, false);
            $requestedType = oneOf($body['paymentType'] ?? 'Monthly Rent', 'Payment type', ['Reservation Fee', 'Monthly Rent', 'Damage Penalty', 'Security Deposit', 'Downpayment']);
            $isSecurityDeposit = $requestedType === 'Security Deposit';
            $isDownpayment = $requestedType === 'Downpayment';
            $paymentType = $isSecurityDeposit || $isDownpayment ? 'Reservation Fee' : $requestedType;
            $billingFrequency = oneOf($body['billingFrequency'] ?? 'Monthly', 'Billing frequency', ['Daily', 'Weekly', 'Monthly']);
            if ($orNumber !== '' && queryOne('SELECT id FROM payments WHERE lower(trim(or_number)) = lower(?)', [$orNumber])) reject(422, 'This OR number has already been used.');
            executeSql('INSERT INTO payments (account_id, amount, paid_amount, status, due_date, paid_date, note, or_number, payment_type, is_security_deposit, is_downpayment, billing_frequency, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [$accountId, $amount, $status === 'paid' ? $amount : null, $status, $dueDate, $status === 'paid' ? today() : null, $note, $orNumber, $paymentType, $isSecurityDeposit ? 1 : 0, $isDownpayment ? 1 : 0, $billingFrequency, $status === 'paid' ? $user['id'] : null, nowMs()]);
            responseCreated(['payment' => loadPayment((int) database()->lastInsertId())]);
        case 'payments-update':
            $id = idParam($param);
            $old = queryOne('SELECT * FROM payments WHERE id = ?', [$id]);
            if (!$old) reject(404, 'Payment was not found.');
            $amount = array_key_exists('amount', $body) ? wholeNumber($body['amount'], 'Amount', 1, 100000000) : (int) $old['amount'];
            $status = array_key_exists('status', $body) ? oneOf($body['status'], 'Status', ['paid', 'pending', 'overdue']) : $old['status'];
            $requestedType = array_key_exists('paymentType', $body)
                ? oneOf($body['paymentType'], 'Payment type', ['Reservation Fee', 'Monthly Rent', 'Damage Penalty', 'Security Deposit', 'Downpayment'])
                : ((int) $old['is_downpayment'] === 1 ? 'Downpayment' : ((int) $old['is_security_deposit'] === 1 ? 'Security Deposit' : $old['payment_type']));
            $isSecurityDeposit = $requestedType === 'Security Deposit';
            $isDownpayment = $requestedType === 'Downpayment';
            $paymentType = $isSecurityDeposit || $isDownpayment ? 'Reservation Fee' : $requestedType;
            $billingFrequency = array_key_exists('billingFrequency', $body) ? oneOf($body['billingFrequency'], 'Billing frequency', ['Daily', 'Weekly', 'Monthly']) : $old['billing_frequency'];
            $dueDate = array_key_exists('dueDate', $body) ? validDate($body['dueDate'], 'Due date') : $old['due_date'];
            $orNumber = array_key_exists('orNumber', $body) ? textValue($body['orNumber'], 'OR number', 64, false) : $old['or_number'];
            $paidDate = $status === 'paid' ? ($old['paid_date'] ?: today()) : null;
            if ($orNumber !== '' && queryOne('SELECT id FROM payments WHERE lower(trim(or_number)) = lower(?) AND id != ?', [$orNumber, $id])) reject(422, 'This OR number has already been used.');
            executeSql('UPDATE payments SET amount = ?, paid_amount = ?, status = ?, due_date = ?, paid_date = ?, or_number = ?, payment_type = ?, is_security_deposit = ?, is_downpayment = ?, billing_frequency = ?, recorded_by = ? WHERE id = ?',
                [$amount, $status === 'paid' ? ($old['paid_amount'] ?: $amount) : null, $status, $dueDate, $paidDate, $orNumber, $paymentType, $isSecurityDeposit ? 1 : 0, $isDownpayment ? 1 : 0, $billingFrequency, $status === 'paid' ? ($old['recorded_by'] ?: $user['id']) : null, $id]);
            jsonResponse(200, ['payment' => loadPayment($id)]);
        case 'payments-delete':
            $result = executeSql('DELETE FROM payments WHERE id = ?', [idParam($param)]);
            if (!$result->rowCount()) reject(404, 'Payment was not found.');
            jsonResponse(200, ['ok' => true]);
        case 'summary':
            ensureMonthlyRentPayments();
            $months = [];
            for ($offset = 5; $offset >= 0; $offset--) {
                $date = new DateTimeImmutable('first day of this month');
                if ($offset > 0) $date = $date->modify('-' . $offset . ' months');
                $months[$date->format('Y-m')] = ['label' => $date->format('M'), 'total' => 0];
            }
            foreach (queryAll("SELECT substr(paid_date, 1, 7) AS month, SUM(COALESCE(paid_amount, amount)) AS total FROM payments
                WHERE status = 'paid' AND paid_date IS NOT NULL GROUP BY month") as $total) {
                if (isset($months[$total['month']])) $months[$total['month']]['total'] = (int) $total['total'];
            }
            $monthly = array_values($months);
            $current = $monthly[5]['total'];
            $previous = $monthly[4]['total'];
            $pending = queryOne("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM payments WHERE status IN ('pending', 'overdue')");
            jsonResponse(200, [
                'residents' => (int) queryOne("SELECT COUNT(*) AS n FROM accounts WHERE role = 'resident'")['n'],
                'rooms' => (int) queryOne('SELECT COUNT(*) AS n FROM rooms')['n'],
                'collected' => (int) queryOne("SELECT COALESCE(SUM(COALESCE(paid_amount, amount)), 0) AS n FROM payments WHERE status = 'paid'")['n'],
                'pendingCount' => (int) $pending['n'], 'pendingTotal' => (int) $pending['total'],
                'overdueCount' => (int) queryOne("SELECT COUNT(*) AS n FROM payments WHERE status = 'overdue' OR (status = 'pending' AND due_date < ?)", [today()])['n'],
                'monthly' => $monthly, 'changePercent' => $previous > 0 ? (int) round((($current - $previous) / $previous) * 100) : null
            ]);
        case 'announcements-list':
            jsonResponse(200, ['announcements' => queryAll('SELECT id, title, body, created_at AS createdAt FROM announcements ORDER BY created_at DESC, id DESC')]);
        case 'announcements-create':
            $title = textValue($body['title'] ?? '', 'Title', 100);
            $message = textValue($body['body'] ?? '', 'Message', 1000);
            $createdAt = array_key_exists('publishedAt', $body)
                ? wholeNumber($body['publishedAt'], 'Date and time', 946684800000, 4102444800000)
                : nowMs();
            executeSql('INSERT INTO announcements (title, body, created_at) VALUES (?, ?, ?)', [$title, $message, $createdAt]);
            $announcementId = (int) database()->lastInsertId();
            executeSql("INSERT INTO resident_notifications (account_id, kind, source_id, title, body, created_at)
                SELECT id, 'announcement', ?, ?, ?, ? FROM accounts WHERE role = 'resident'", [$announcementId, $title, $message, $createdAt]);
            responseCreated(['id' => $announcementId]);
        case 'announcements-delete':
            $result = executeSql('DELETE FROM announcements WHERE id = ?', [idParam($param)]);
            if (!$result->rowCount()) reject(404, 'Announcement was not found.');
            jsonResponse(200, ['ok' => true]);
        case 'reminders-list':
            jsonResponse(200, ['reminders' => queryAll('SELECT id, kind, title, body, due_date AS dueDate, created_at AS createdAt FROM reminders ORDER BY created_at DESC, id DESC')]);
        case 'reminders-create':
            $kind = oneOf($body['kind'] ?? '', 'Type', ['payment', 'curfew', 'event']);
            $title = textValue($body['title'] ?? '', 'Title', 100);
            $message = textValue($body['body'] ?? '', 'Message', 500, false);
            $dueDate = validDate($body['dueDate'] ?? null, 'Date', false);
            $createdAt = nowMs();
            executeSql('INSERT INTO reminders (kind, title, body, due_date, created_at) VALUES (?, ?, ?, ?, ?)', [$kind, $title, $message, $dueDate, $createdAt]);
            $reminderId = (int) database()->lastInsertId();
            $notificationBody = $message !== '' ? $message : ($dueDate !== null ? 'Date: ' . $dueDate : 'A new reminder was posted.');
            executeSql("INSERT INTO resident_notifications (account_id, kind, source_id, title, body, created_at)
                SELECT id, 'reminder', ?, ?, ?, ? FROM accounts WHERE role = 'resident'", [$reminderId, $title, $notificationBody, $createdAt]);
            responseCreated(['id' => $reminderId]);
        case 'reminders-delete':
            $result = executeSql('DELETE FROM reminders WHERE id = ?', [idParam($param)]);
            if (!$result->rowCount()) reject(404, 'Reminder was not found.');
            jsonResponse(200, ['ok' => true]);
        case 'visitors-list':
            jsonResponse(200, ['visitors' => queryAll(visitorSelect() . ' ORDER BY v.visited_at DESC, v.id DESC')]);
        case 'visitors-create':
            $visitorName = textValue($body['visitorName'] ?? '', 'Visitor name');
            $accountId = textValue($body['accountId'] ?? '', 'Resident', 64);
            if (!queryOne("SELECT 1 FROM accounts WHERE id = ? AND role = 'resident'", [$accountId])) reject(400, 'Choose a valid resident.');
            $visitedAt = wholeNumber($body['visitedAt'] ?? null, 'Date and time', 946684800000, 4102444800000);
            executeSql("INSERT INTO visitors (visitor_name, account_id, visited_at, created_at, status) VALUES (?, ?, ?, ?, 'approved')",
                [$visitorName, $accountId, $visitedAt, nowMs()]);
            responseCreated(['id' => (int) database()->lastInsertId()]);
        case 'visitors-approve':
            $id = idParam($param);
            $result = executeSql("UPDATE visitors SET status = 'approved' WHERE id = ? AND status = 'pending'", [$id]);
            if (!$result->rowCount() && !queryOne('SELECT 1 FROM visitors WHERE id = ?', [$id])) reject(404, 'Visitor entry was not found.');
            executeSql('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE visitor_id = ?', [nowMs(), $id]);
            jsonResponse(200, ['ok' => true]);
        case 'visitors-delete':
            $result = executeSql('DELETE FROM visitors WHERE id = ?', [idParam($param)]);
            if (!$result->rowCount()) reject(404, 'Visitor entry was not found.');
            jsonResponse(200, ['ok' => true]);
        case 'notifications-list':
            $unread = (int) queryOne('SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND read_at IS NULL', [$user['id']])['n'];
            $notifications = queryAll('SELECT id, visitor_id AS visitorId, title, body, created_at AS createdAt, read_at AS readAt
                FROM notifications WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT 100', [$user['id']]);
            jsonResponse(200, ['notifications' => $notifications, 'unreadCount' => $unread]);
        case 'notifications-read':
            $result = executeSql('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND account_id = ?', [nowMs(), idParam($param), $user['id']]);
            if (!$result->rowCount()) reject(404, 'Notification was not found.');
            jsonResponse(200, ['ok' => true]);
        case 'resident-notifications-list':
            $unread = (int) queryOne('SELECT COUNT(*) AS n FROM resident_notifications WHERE account_id = ? AND read_at IS NULL', [$user['id']])['n'];
            $notifications = queryAll('SELECT id, kind, title, body, created_at AS createdAt, read_at AS readAt
                FROM resident_notifications WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT 100', [$user['id']]);
            jsonResponse(200, ['notifications' => $notifications, 'unreadCount' => $unread]);
        case 'resident-notifications-read':
            $result = executeSql('UPDATE resident_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND account_id = ?', [nowMs(), idParam($param), $user['id']]);
            if (!$result->rowCount()) reject(404, 'Notification was not found.');
            jsonResponse(200, ['ok' => true]);
        case 'curfew-admin':
            jsonResponse(200, ['curfewTime' => curfewTime()]);
        case 'curfew-update':
            $time = validTime($body['curfewTime'] ?? null, 'Curfew time');
            executeSql("UPDATE settings SET value = ? WHERE key = 'curfew_time'", [$time]);
            jsonResponse(200, ['curfewTime' => $time]);
        case 'overview':
            ensureMonthlyRentPayments();
            $room = $user['room_id'] === null ? null : loadRoom((int) $user['room_id']);
            $payments = array_map('mapPayment', queryAll(paymentSelect() . ' WHERE p.account_id = ? ORDER BY p.due_date DESC, p.id DESC', [today(), $user['id']]));
            $unpaid = array_values(array_filter($payments, static fn(array $p): bool => $p['status'] !== 'paid'));
            usort($unpaid, static fn(array $a, array $b): int => strcmp($a['dueDate'], $b['dueDate']));
            $visitors = queryAll(visitorSelect() . ' WHERE v.account_id = ? ORDER BY v.visited_at DESC LIMIT 50', [$user['id']]);
            $roomData = $room ? [
                'number' => $room['number'], 'capacity' => $room['capacity'], 'rent' => $room['rent'],
                'maintenance' => $room['maintenance'], 'notes' => $room['notes'], 'photoData' => $room['photoData'],
                'roommates' => array_values(array_map(static fn(array $o): string => $o['name'], array_filter($room['occupants'], static fn(array $o): bool => $o['id'] !== $user['id'])))
            ] : null;
            jsonResponse(200, [
                'user' => publicUser($user), 'room' => $roomData, 'payments' => $payments,
                'nextPayment' => $unpaid[0] ?? null,
                'totalPaid' => array_sum(array_map(static fn(array $p): int => $p['status'] === 'paid' ? $p['amount'] : 0, $payments)),
                'visitors' => $visitors, 'curfew' => ['curfewTime' => curfewTime()]
            ]);
        case 'resident-payment-monthly':
            $amount = wholeNumber($body['amount'] ?? null, 'Amount', 1, 100000000);
            $orNumber = textValue($body['orNumber'] ?? '', 'OR number', 64);
            $orImageData = paymentProofImage($body['orImageData'] ?? '');
            $pdo = database();
            $pdo->beginTransaction();
            try {
                if (queryOne('SELECT id FROM payments WHERE lower(trim(or_number)) = lower(?)', [$orNumber])) {
                    reject(422, 'This OR number has already been used.');
                }
                executeSql("INSERT INTO payments
                    (account_id, amount, paid_amount, status, due_date, note, or_number, payment_type, billing_frequency,
                     or_image_data, or_verification_status, or_submitted_amount, created_at)
                    VALUES (?, ?, NULL, 'pending', ?, 'Monthly rent payment', ?, 'Monthly Rent', 'Monthly',
                      ?, 'pending', ?, ?)",
                    [$user['id'], $amount, today(), $orNumber, $orImageData, $amount, nowMs()]);
                $paymentId = (int) $pdo->lastInsertId();
                $pdo->commit();
            } catch (Throwable $error) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                throw $error;
            }
            responseCreated(['payment' => loadPayment($paymentId)]);
        case 'resident-payment-advance':
            ensureMonthlyRentPayments();
            $resident = queryOne("SELECT a.move_in_date, a.status, r.rent
                FROM accounts a LEFT JOIN rooms r ON r.id = a.room_id
                WHERE a.id = ? AND a.role = 'resident'", [$user['id']]);
            if (!$resident) reject(404, 'Resident was not found.');
            $hasRoomRent = $resident['move_in_date'] && in_array($resident['status'], ['Active', 'On Leave'], true) && (int) $resident['rent'] > 0;
            $amount = $hasRoomRent ? null : wholeNumber($body['amount'] ?? null, 'Amount', 1, 100000000);
            $pdo = database();
            $pdo->beginTransaction();
            try {
                $currentMonth = substr(today(), 0, 7);
                $unpaidAdvance = queryOne("SELECT id FROM payments WHERE account_id = ? AND payment_type = 'Monthly Rent'
                    AND billing_frequency = 'Monthly' AND substr(due_date, 1, 7) > ? AND status != 'paid'
                    ORDER BY due_date ASC LIMIT 1", [$user['id'], $currentMonth]);
                if ($unpaidAdvance) {
                    $pdo->commit();
                    jsonResponse(200, ['payment' => loadPayment((int) $unpaidAdvance['id']), 'alreadyExists' => true]);
                }
                $latest = queryOne("SELECT MAX(COALESCE(billing_period, substr(due_date, 1, 7))) AS month
                    FROM payments WHERE account_id = ? AND payment_type = 'Monthly Rent' AND billing_frequency = 'Monthly'", [$user['id']]);
                $base = ($latest['month'] ?? null) && $latest['month'] > $currentMonth ? $latest['month'] : $currentMonth;
                $nextMonthDate = (new DateTimeImmutable($base . '-01'))->modify('first day of next month');
                $nextMonth = $nextMonthDate->format('Y-m');
                $existing = queryOne("SELECT id FROM payments WHERE account_id = ? AND payment_type = 'Monthly Rent'
                    AND billing_frequency = 'Monthly' AND (billing_period = ? OR substr(due_date, 1, 7) = ?) LIMIT 1",
                    [$user['id'], $nextMonth, $nextMonth]);
                if ($existing) {
                    $pdo->commit();
                    jsonResponse(200, ['payment' => loadPayment((int) $existing['id']), 'alreadyExists' => true]);
                }
                $lastDay = (int) $nextMonthDate->modify('last day of this month')->format('d');
                $moveInDay = $hasRoomRent ? (int) substr($resident['move_in_date'], 8, 2) : 1;
                $dueDate = $nextMonth . '-' . str_pad((string) min($moveInDay, $lastDay), 2, '0', STR_PAD_LEFT);
                executeSql("INSERT INTO payments
                    (account_id, amount, paid_amount, status, due_date, note, payment_type, billing_frequency, billing_period, created_at)
                    VALUES (?, ?, NULL, 'pending', ?, ?, 'Monthly Rent', 'Monthly', ?, ?)",
                    [$user['id'], $amount ?? (int) $resident['rent'], $dueDate, 'Advance rent for ' . $nextMonth, $nextMonth, nowMs()]);
                $paymentId = (int) $pdo->lastInsertId();
                $pdo->commit();
            } catch (Throwable $error) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                throw $error;
            }
            responseCreated(['payment' => loadPayment($paymentId), 'alreadyExists' => false]);
        case 'resident-payment-deposit':
            $amount = wholeNumber($body['amount'] ?? null, 'Amount', 1, 100000000);
            $orNumber = textValue($body['orNumber'] ?? '', 'OR number', 64);
            $orImageData = paymentProofImage($body['orImageData'] ?? '');
            $pdo = database();
            $pdo->beginTransaction();
            try {
                if (queryOne('SELECT id FROM payments WHERE account_id = ? AND is_security_deposit = 1 LIMIT 1', [$user['id']])) {
                    reject(409, 'A security deposit payment already exists. Submit or review its payment proof in your payment history.');
                }
                if (queryOne('SELECT id FROM payments WHERE lower(trim(or_number)) = lower(?)', [$orNumber])) {
                    reject(422, 'This OR number has already been used.');
                }
                executeSql("INSERT INTO payments
                    (account_id, amount, paid_amount, status, due_date, note, or_number, payment_type, is_security_deposit,
                     billing_frequency, or_image_data, or_verification_status, or_submitted_amount, created_at)
                    VALUES (?, ?, NULL, 'pending', ?, 'Security deposit', ?, 'Reservation Fee', 1,
                      'Monthly', ?, 'pending', ?, ?)",
                    [$user['id'], $amount, today(), $orNumber, $orImageData, $amount, nowMs()]);
                $paymentId = (int) $pdo->lastInsertId();
                $pdo->commit();
            } catch (Throwable $error) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                throw $error;
            }
            responseCreated(['payment' => loadPayment($paymentId)]);
        case 'resident-payment-or':
            $id = idParam($param);
            $orNumber = textValue($body['orNumber'] ?? '', 'OR number', 64);
            $submittedAmount = array_key_exists('submittedAmount', $body)
                ? wholeNumber($body['submittedAmount'], 'Amount to pay', 1, 100000000) : null;
            $orImageData = paymentProofImage($body['orImageData'] ?? '');
            $pdo = database();
            $pdo->beginTransaction();
            try {
                $payment = queryOne('SELECT id, amount, status, or_verification_status FROM payments WHERE id = ? AND account_id = ?', [$id, $user['id']]);
                if (!$payment) reject(404, 'Payment was not found.');
                if ($payment['status'] === 'paid') reject(409, 'This payment has already been paid.');
                if ($payment['or_verification_status'] === 'pending') reject(409, 'This OR is already awaiting administrator verification.');
                $amountToSubmit = $submittedAmount ?? (int) $payment['amount'];
                if ($amountToSubmit > (int) $payment['amount']) reject(422, 'Amount to pay cannot exceed the remaining bill.');
                if (queryOne('SELECT id FROM payments WHERE lower(trim(or_number)) = lower(?) AND id != ?', [$orNumber, $id])) {
                    reject(422, 'This OR number has already been used.');
                }
                executeSql("UPDATE payments SET or_number = ?, or_image_data = ?, or_submitted_amount = ?, or_verification_status = 'pending'
                    WHERE id = ? AND account_id = ?", [$orNumber, $orImageData, $amountToSubmit, $id, $user['id']]);
                $pdo->commit();
            } catch (Throwable $error) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                throw $error;
            }
            jsonResponse(200, ['payment' => loadPayment($id)]);
        case 'resident-payment-or-update':
            $id = idParam($param);
            $orNumber = textValue($body['orNumber'] ?? '', 'OR number', 64);
            $submittedAmount = array_key_exists('submittedAmount', $body)
                ? wholeNumber($body['submittedAmount'], 'Amount to pay', 1, 100000000) : null;
            $orImageData = array_key_exists('orImageData', $body) ? paymentProofImage($body['orImageData']) : null;
            $pdo = database();
            $pdo->beginTransaction();
            try {
                $payment = queryOne('SELECT amount, status, or_verification_status, or_submitted_amount FROM payments WHERE id = ? AND account_id = ?', [$id, $user['id']]);
                if (!$payment) reject(404, 'Payment was not found.');
                if ($payment['status'] === 'paid' || $payment['or_verification_status'] !== 'pending') {
                    reject(409, 'This payment is no longer awaiting administrator verification.');
                }
                $amountToSubmit = $submittedAmount ?? (int) ($payment['or_submitted_amount'] ?: $payment['amount']);
                if ($amountToSubmit > (int) $payment['amount']) reject(422, 'Amount to pay cannot exceed the remaining bill.');
                if (queryOne('SELECT id FROM payments WHERE lower(trim(or_number)) = lower(?) AND id != ?', [$orNumber, $id])) {
                    reject(422, 'This OR number has already been used.');
                }
                executeSql("UPDATE payments SET or_number = ?, or_image_data = COALESCE(?, or_image_data), or_submitted_amount = ?
                    WHERE id = ? AND account_id = ? AND status != 'paid' AND or_verification_status = 'pending'",
                    [$orNumber, $orImageData, $amountToSubmit, $id, $user['id']]);
                $pdo->commit();
            } catch (Throwable $error) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                throw $error;
            }
            jsonResponse(200, ['payment' => loadPayment($id)]);
        case 'visitor-submit':
            $visitorName = textValue($body['visitorName'] ?? '', 'Visitor name');
            $visitedAt = wholeNumber($body['visitedAt'] ?? null, 'Date and time', 946684800000, 4102444800000);
            $createdAt = nowMs();
            executeSql("INSERT INTO visitors (visitor_name, account_id, visited_at, created_at, status) VALUES (?, ?, ?, ?, 'approved')",
                [$visitorName, $user['id'], $visitedAt, $createdAt]);
            $visitorId = (int) database()->lastInsertId();
            jsonResponse(201, ['visitor' => queryOne(visitorSelect() . ' WHERE v.id = ?', [$visitorId])]);
    }
} catch (ApiError $error) {
    jsonResponse($error->status, ['error' => $error->getMessage()]);
} catch (Throwable $error) {
    error_log('DMS API error: ' . $error->getMessage());
    jsonResponse(500, ['error' => 'Something went wrong on the server.']);
}
