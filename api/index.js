'use strict';
require('dotenv').config();

const app = require('../src/app');

module.exports = (req, res) => {
  app(req, res);
};
