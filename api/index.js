'use strict';
/**
 * Vercel entry point. The same app object, wrapped as one function.
 *
 * Read README §"What works where": the tender upload path only works here
 * with UPLOAD_MODE=blob, because Vercel caps request bodies at 4.5 MB.
 */
require('dotenv').config();
module.exports = require('../src/app');
