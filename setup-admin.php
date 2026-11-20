<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

if (!extension_loaded('pdo_sqlite')) {
    fwrite(STDERR, "PDO SQLite is required. Enable pdo_sqlite in XAMPP's php.ini.\n");
    exit(1);
}

$databasePath = __DIR__ . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'dormitory-v2.sqlite';
if (!is_file($databasePath)) {
    fwrite(STDERR, "Database not found: " . $databasePath . "\n");
    exit(1);
}

$db = new PDO('sqlite:' . $databasePath, null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
]);
$db->exec('PRAGMA foreign_keys = ON');
$db->exec("CREATE TABLE IF NOT EXISTS php_credentials (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL
)");

$username = $argv[1] ?? '';
if ($username === '') {
    $username = trim((string) readline('Admin username (use an existing admin name to reset it): '));
}
if (!preg_match('/^[A-Za-z0-9._-]{3,32}$/', $username)) {
    fwrite(STDERR, "Username must be 3-32 letters, numbers, dots, dashes or underscores.\n");
    exit(1);
}
$generated = ($argv[2] ?? '') === '--generate';
$password = $generated
    ? rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=')
    : (string) readline('New admin password (12-128 characters): ');
$confirmation = $generated ? $password : (string) readline('Confirm password: ');
if (strlen($password) < 12 || strlen($password) > 128) {
    fwrite(STDERR, "Password must be between 12 and 128 characters.\n");
    exit(1);
}
if (!hash_equals($password, $confirmation)) {
    fwrite(STDERR, "Passwords do not match.\n");
    exit(1);
}

$existing = $db->prepare('SELECT id, role FROM accounts WHERE username = ? COLLATE NOCASE');
$existing->execute([$username]);
$account = $existing->fetch();
if ($account && $account['role'] !== 'admin') {
    fwrite(STDERR, "That username already belongs to a resident. Choose a different admin username.\n");
    exit(1);
}

if ($account) {
    $statement = $db->prepare('INSERT INTO php_credentials (account_id, password_hash) VALUES (?, ?)
        ON CONFLICT(account_id) DO UPDATE SET password_hash = excluded.password_hash');
    $statement->execute([$account['id'], password_hash($password, PASSWORD_DEFAULT)]);
    $db->prepare('DELETE FROM sessions WHERE account_id = ?')->execute([$account['id']]);
    $message = 'Admin password reset.';
} else {
    $id = bin2hex(random_bytes(16));
    $db->beginTransaction();
    try {
        $insert = $db->prepare("INSERT INTO accounts (id, username, name, email, phone, role, room_id, password_salt, password_hash, created_at)
            VALUES (?, ?, 'Residence Administrator', '', '', 'admin', NULL, '', '', ?)");
        $insert->execute([$id, $username, (int) floor(microtime(true) * 1000)]);
        $credential = $db->prepare('INSERT INTO php_credentials (account_id, password_hash) VALUES (?, ?)');
        $credential->execute([$id, password_hash($password, PASSWORD_DEFAULT)]);
        $db->commit();
    } catch (Throwable $error) {
        $db->rollBack();
        throw $error;
    }
    $message = 'Admin account created.';
}

fwrite(STDOUT, $message . ' Sign in with the Admin tab using "' . $username . '".' . PHP_EOL);
if ($generated) fwrite(STDOUT, 'Temporary password: ' . $password . PHP_EOL);
