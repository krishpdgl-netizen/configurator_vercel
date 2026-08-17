'use strict';
/** Render / local entry point. Vercel uses api/index.js instead. */
require('dotenv').config();

const app = require('./src/app');

const port = Number(process.env.PORT || 3000);

app.ensureReady()
  .then(() => {
    app.listen(port, () => {
      console.log(`configurator listening on :${port}  (upload mode: ${process.env.UPLOAD_MODE || 'disk'})`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialise the database:', err.message);
    process.exit(1);
  });
