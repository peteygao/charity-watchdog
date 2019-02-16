const express = require('express');
const path = require('path');
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;
const morgan = require('morgan');
const { Pool } = require('pg');
const { execSync } = require('child_process');
const Meerkat = require('./meerkat');

const isDev = process.env.NODE_ENV !== 'production';
const PORT = process.env.PORT || 5000;
const databaseUrl = process.env.DATABASE_URL || new String(execSync('heroku config:get DATABASE_URL -a charity-watchdog')).trim();

const pool = new Pool({ connectionString: databaseUrl, ssl: true, statement_timeout: 25 });

// Multi-process to utilize all CPU cores.
if (!isDev && cluster.isMaster) {
  console.error(`Node cluster master ${process.pid} is running`);

  // Fork workers.
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.error(`Node cluster worker ${worker.process.pid} exited: code ${code}, signal ${signal}`);
  });

} else {
  const app = express();

  // Attach a logging middleware
  app.use(morgan('tiny'));

  // Priority serve any static files.
  app.use(express.static(path.resolve(__dirname, '../react-ui/build')));

  // Answer API requests.
  app.get('/api', function (req, res) {
    res.set('Content-Type', 'application/json');
    res.send('{"message":"Coming Soon"}');
  });

  app.get('/api/v1/charity', (req, res) => {
    res.set('Content-Type', 'application/json');

    pool.query('SELECT id, name, description, wallet_address FROM charities', (err, queryRes) => {
      if (err) {
        console.error(err);
        res.status(500).send({ error: err });
      } else {
        res.send({ data: queryRes.rows });
      }
    });
  });

  app.get('/api/v1/charity/:charityID', (req, res) => {
    res.set('Content-Type', 'application/json');

    pool.query('SELECT * FROM transactions WHERE charity_id = $1', (err, queryRes) => {
      if (err) {
        console.error(err);
        res.status(500).send({ error: err });
      } else {
        res.send({ data: queryRes.rows });
      }
    });
  });

  app.post('/api/v1/charity/new', (req, res) => {
    res.set('Content-Type', 'application/json');
    const { name, description, walletAddress } = req.body;

    Meerkat
      .createAddressSubscription(walletAddress)
      .then((response) => {
        if (!response.ok) {
          throw new Error(response.status);
        }

        console.log(`Meerkat.createAddressSubscription response body: ${response.body}`)
        const meerkatSubID = response.body;

        pool.query(
          `INSERT INTO charities
            (name, description, wallet_address, meerkat_subscription_id)
            VALUES
            ($1, $2, $3, $4)
            RETURNING id`,
          [name, description, walletAddress, meerkatSubID],
          (err, queryRes) => {
            if (err) {
              res.status(500).send({ error: err });
            } else {
              res.send({ data: queryRes.rows[0].charityID });
            }
        });
      })
    ;
  });

  app.get('/webhook/v1/address', (req, res) => {
    console.log(`Received a webhook: ${req.body}`);
    res.status(200).end();
  });

  // All remaining requests return the React app, so it can handle routing.
  app.get('*', function(request, response) {
    response.sendFile(path.resolve(__dirname, '../react-ui/build', 'index.html'));
  });

  app.listen(PORT, function () {
    console.error(`Node ${isDev ? 'dev server' : 'cluster worker '+process.pid}: listening on port ${PORT}`);
  });
}
