'use strict';
const path = require('path');
const { APP_ROOT, loadEnv } = require('./env');

loadEnv();

const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const DATA_DIR = path.resolve(APP_ROOT, process.env.DATA_DIR || 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const USERS_INDEX = path.join(DATA_DIR, 'users-index.json');

module.exports = { APP_ROOT, PUBLIC_DIR, DATA_DIR, USERS_DIR, LOG_DIR, USERS_INDEX };
