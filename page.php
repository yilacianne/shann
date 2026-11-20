<?php
declare(strict_types=1);

date_default_timezone_set('Asia/Manila');
$page = $_GET['page'] ?? '';
$allowed = ['login.html', 'index.html', 'resident.html', 'register.html'];
if (!in_array($page, $allowed, true)) {
    http_response_code(404);
    exit('Not found.');
}

$base = str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/'));
$base = $base === '/' || $base === '.' ? '' : rtrim($base, '/');
$token = $_COOKIE['dms_session'] ?? '';
$account = null;
if (is_string($token) && $token !== '') {
    try {
        $db = new PDO('sqlite:' . __DIR__ . '/data/dormitory-v2.sqlite', null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
        ]);
        $db->exec('PRAGMA foreign_keys = ON');
        $statement = $db->prepare('SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?');
        $statement->execute([hash('sha256', $token), (int) floor(microtime(true) * 1000)]);
        $account = $statement->fetch() ?: null;
    } catch (Throwable $error) {
        error_log('DMS page auth error: ' . $error->getMessage());
    }
}

if ($page === 'register.html') {
    header('Location: ' . $base . '/login.html', true, 302);
    exit;
}
if ($page === 'login.html' && $account) {
    header('Location: ' . $base . ($account['role'] === 'admin' ? '/index.html' : '/resident.html'), true, 302);
    exit;
}
if ($page === 'index.html' && (!$account || $account['role'] !== 'admin')) {
    header('Location: ' . $base . ($account ? '/resident.html' : '/login.html'), true, 302);
    exit;
}
if ($page === 'resident.html' && (!$account || $account['role'] !== 'resident')) {
    header('Location: ' . $base . ($account ? '/index.html' : '/login.html'), true, 302);
    exit;
}

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: strict-origin-when-cross-origin');
header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
readfile(__DIR__ . '/public/' . $page);
