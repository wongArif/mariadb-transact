(function() {
  var EventEmitter, MariaSQL, Q, TransactionManager,
    __hasProp = {}.hasOwnProperty,
    __extends = function(child, parent) { for (var key in parent) { if (__hasProp.call(parent, key)) child[key] = parent[key]; } function ctor() { this.constructor = child; } ctor.prototype = parent.prototype; child.prototype = new ctor(); child.__super__ = parent.prototype; return child; };

  EventEmitter = require("events").EventEmitter;

  MariaSQL = require("mariasql");

  Q = require("q");

  TransactionManager = (function(_super) {
    __extends(TransactionManager, _super);


    /*
      Handles a queue of transactions and a pool of MariaSQL connections.
     */

    function TransactionManager(opts) {
      if (!opts) {
        opts = {};
      }
      this.conn = {
        connected: false
      };
      this.autoconvert = typeof opts.metadata === "undefined" ? false : !!opts.metadata;
      this.pool = [];
      this.queue = [];
      this.poolsize = typeof opts.poolsize === "number" ? opts.poolsize : 20;
      this.conncfg = opts;
      this.log = opts.log || {
        info: function() {},
        warn: function() {},
        error: function() {}
      };
    }

    TransactionManager.prototype.createConnection = function() {

      /*
        Create a new connection object.
       */
      var conn;
      conn = new MariaSQL();
      conn.connect(this.conncfg);
      conn.command = conn.cmd = this.command.bind(this, conn);
      conn.commit = this.commit.bind(this, conn);
      conn.fetchArray = this.fetchArray.bind(this, conn);
      conn.fetchOne = this.fetchOne.bind(this, conn);
      conn.rollback = this.rollback.bind(this, conn);
      return conn;
    };

    TransactionManager.prototype.init = function() {

      /*
        Initialize all connections.
       */
      var deferred;
      deferred = Q.defer();
      this.conn = this.createConnection();
      this.conn.on("error", (function(_this) {
        return function(err) {
          _this.emit("error", err);
          return deferred.reject(err);
        };
      })(this));
      this.conn.on("connect", (function(_this) {
        return function() {
          var i, waiting, wrapper, _i, _ref, _results;
          waiting = 0;
          if (_this.poolsize > 0) {
            wrapper = function() {
              var conn;
              waiting++;
              conn = _this.createConnection();
              return conn.on("connect", function() {
                var q;
                q = conn.query("SET autocommit = 0");
                q.on("result", function() {});
                q.on("error", function(err) {
                  return _this.emit("error", err);
                });
                return q.on("end", function() {
                  _this.pool.push(conn);
                  waiting--;
                  if (waiting <= 0) {
                    _this.emit("init");
                    _this.log.info("TransactionManager initialized.");
                    return deferred.resolve();
                  }
                });
              });
            };
            _results = [];
            for (i = _i = 1, _ref = _this.poolsize; 1 <= _ref ? _i <= _ref : _i >= _ref; i = 1 <= _ref ? ++_i : --_i) {
              _results.push(wrapper());
            }
            return _results;
          } else {
            _this.emit("init");
            return deferred.resolve();
          }
        };
      })(this));
      return deferred.promise;
    };

    TransactionManager.prototype.basic = function() {

      /*
        Get a basic, non-transactional connection. (Only for simple queries.)
       */
      var deferred;
      deferred = Q.defer();
      setImmediate((function(_this) {
        return function() {
          if (_this.conn.connected) {
            return deferred.resolve(_this.conn);
          } else {
            return deferred.reject("The transaction manager is not connected to a database.");
          }
        };
      })(this));
      return deferred.promise;
    };

    TransactionManager.prototype.close = function() {

      /*
        Close all connections.
       */
      var deferred;
      deferred = Q.defer();
      setImmediate((function(_this) {
        return function() {
          var c, _i, _len, _ref;
          _this.conn.end();
          _ref = _this.pool;
          for (_i = 0, _len = _ref.length; _i < _len; _i++) {
            c = _ref[_i];
            c.end();
          }
          return deferred.resolve();
        };
      })(this));
      return deferred.promise;
    };

    TransactionManager.prototype.checkQueue = function() {

      /*
        Check the queue for waiting transaction initializations.
       */
      var deferred;
      if (this.queue.length > 0 && this.pool.length > 0) {
        this.log.info("TransactionManager starting queued transaction.");
        deferred = this.queue.shift();
        return deferred.resolve(this.pool.shift());
      }
    };

    TransactionManager.prototype.finalCmd = function(cmd, conn) {

      /*
        Execute rollback or commit.
       */
      var deferred, q, reterr;
      deferred = Q.defer();
      q = conn.query(cmd);
      reterr = null;
      q.on("result", (function(_this) {
        return function(res) {
          return res.on("error", function(err) {
            return reterr = err;
          });
        };
      })(this));
      q.on("end", (function(_this) {
        return function() {
          if (reterr === null) {
            deferred.resolve();
          } else {
            deferred.reject(reterr);
          }
          return setImmediate(function() {
            _this.pool.push(conn);
            return _this.checkQueue();
          });
        };
      })(this));
      return deferred.promise;
    };

    TransactionManager.prototype.commit = function(conn) {

      /*
        Commit a transaction.
       */
      return this.finalCmd("COMMIT", conn);
    };

    TransactionManager.prototype.rollback = function(conn) {

      /*
        Roll back a transaction.
       */
      return this.finalCmd("ROLLBACK", conn);
    };

    TransactionManager.prototype.command = function(conn, sql, params) {

      /*
        Perform an SQL command (no result returned, use for INSERT/UPDATE queries).
       */
      var deferred, q, rerr, ret;
      deferred = Q.defer();
      if (!params) {
        params = {};
      }
      ret = null;
      rerr = null;
      q = conn.query(sql, params);
      q.on("result", function(res) {
        res.on("end", function(info) {
          return ret = info;
        });
        return res.on("error", function(err) {
          return rerr = err;
        });
      });
      q.on("end", function() {
        if (rerr === null) {
          return deferred.resolve(ret);
        } else {
          return deferred.reject(rerr);
        }
      });
      return deferred.promise;
    };

    TransactionManager.prototype.convert = function(row, types) {

      /*
        Convert row elements based on type info.
       */
      var key, t, _results;
      _results = [];
      for (key in row) {
        t = types[key];
        if (t === "DATE" || t === "DATETIME" || t === "TIMESTAMP") {
          row[key] = new Date(row[key]);
        }
        if (t === "DECIMAL" || t === "DOUBLE" || t === "FLOAT") {
          row[key] = parseFloat(row[key]);
        }
        if (t === "INTEGER" || t === "TINYINT" || t === "SMALLINT" || t === "MEDIUMINT" || t === "BIGINT") {
          _results.push(row[key] = parseInt(row[key]));
        } else {
          _results.push(void 0);
        }
      }
      return _results;
    };

    TransactionManager.prototype.fetchArray = function(conn, sql, params) {

      /*
        Fetch an array of SQL result rows.
       */
      var deferred, q, rerr, rows;
      deferred = Q.defer();
      if (!params) {
        params = {};
      }
      rows = [];
      rerr = null;
      q = conn.query(sql, params);
      q.on("result", (function(_this) {
        return function(res) {
          res.on("row", function(row, info) {
            if (info && info.types && _this.autoconvert) {
              _this.convert(row, info.types);
            }
            return rows.push(row);
          });
          return res.on("error", function(err) {
            return rerr = err;
          });
        };
      })(this));
      q.on("end", (function(_this) {
        return function() {
          if (rerr === null) {
            return deferred.resolve(rows);
          } else {
            return deferred.reject(rerr);
          }
        };
      })(this));
      return deferred.promise;
    };

    TransactionManager.prototype.fetchOne = function(conn, sql, params) {

      /*
        Fetch a single SQL result row.
       */
      var deferred, q, rerr, resrow;
      deferred = Q.defer();
      if (!params) {
        params = {};
      }
      resrow = null;
      rerr = null;
      q = conn.query(sql, params);
      q.on("result", (function(_this) {
        return function(res) {
          res.on("row", function(row, info) {
            if (info && info.types && _this.autoconvert) {
              _this.convert(row, info.types);
            }
            if (resrow === null) {
              return resrow = row;
            }
          });
          return res.on("error", function(err) {
            return rerr = err;
          });
        };
      })(this));
      q.on("end", (function(_this) {
        return function() {
          if (rerr === null) {
            return deferred.resolve(resrow);
          } else {
            return deferred.reject(rerr);
          }
        };
      })(this));
      return deferred.promise;
    };

    TransactionManager.prototype.begin = function() {

      /*
        Attempt to begin a transaction. Add to promise to queue if connection pool is empty.
       */
      var deferred;
      deferred = Q.defer();
      setImmediate((function(_this) {
        return function() {
          if (_this.pool.length > 0) {
            return deferred.resolve(_this.pool.shift());
          } else {
            _this.queue.push(deferred);
            return _this.log.info("TransactionManager added transaction to queue. (Pool is empty.)");
          }
        };
      })(this));
      return deferred.promise;
    };

    return TransactionManager;

  })(EventEmitter);

  module.exports = TransactionManager;

}).call(this);
