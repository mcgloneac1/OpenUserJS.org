var AWS = require('aws-sdk');
var Script = require('../models/script').Script;
var User = require('../models/user').User;
var cleanFilename = require('../libs/helpers').cleanFilename;
var RepoManager = require('../libs/repoManager');
var bucketName = 'OpenUserJS.org';

if (process.env.NODE_ENV === 'production') {
  AWS.config.update({ region: 'us-east-1' });
} else {
  // You need to install (and ruby too): https://github.com/jubos/fake-s3
  // Then run the fakes3.sh script or: fakes3 -r fakeS3 -p 10001
  AWS.config.update({ accessKeyId: 'fakeId', secretAccessKey: 'fakeKey',
    httpOptions: { 
    proxy: 'localhost:10001', agent: require('http').globalAgent 
  }});
}

function getInstallName (req, res) {
  var username = req.route.params.username.toLowerCase();
  var namespace = req.route.params.namespace;
  return username + '/' + (namespace ? namespace + '/' : '') 
    + req.route.params.scriptname;
}

exports.sendScript = function (req, res, next) {
  var s3 = new AWS.S3();
  var accept = req.headers['Accept'];
  var installName = null;

  if (accept === 'text/x-userscript-meta') { 
    return exports.sendMeta(req, res, next); 
  }
  installName = getInstallName(req, res);

  // Update the install count
  Script.findOne({ installName: installName }, function (err, script) {
    if (!script) { return next(); }

    // Send the script
    res.set('Content-Type', 'text/javascript; charset=utf-8');
    s3.getObject({ Bucket: bucketName, Key: installName })
      .createReadStream().pipe(res);

    ++script.installs;
    script.save(function (err, script) {});
  });
}

exports.sendMeta = function (req, res, next) {
  var installName = getInstallName(req, res).replace(/\.meta\.js$/, '.user.js');

  Script.findOne({ installName: installName }, function (err, script) {
    var key = null;
    var meta = null;
    var lines = [];

    if (!script) { return next(); }

    meta = script.meta;
    for (key in meta) {
      lines.push('// @' + key + '    ' + meta[key]);
    }

    res.set('Content-Type', 'text/javascript; charset=utf-8');
    res.write('// ==UserScript==\n');
    res.write(lines.reverse().join('\n'));
    res.end('\n// ==/UserScript==\n');
  });
}

// Modified from Count Issues (http://userscripts.org/scripts/show/69307)
// By Marti Martz (http://userscripts.org/users/37004)
function parseMeta(aString) {
  var re = /\/\/ @(\S+)(?:\s+(.*))?/;
  var headers = {};
  var name = null;
  var key = null;
  var value = null;
  var line = null;
  var lineMatches = null;
  var lines = {};

  lines = aString.split(/[\r\n]+/).filter(function (e, i, a) {
    return (e.match(re));
  });

  for (line in lines) {
    lineMatches = lines[line].replace(/\s+$/, "").match(re);
    name = lineMatches[1];
    value = lineMatches[2];
    headers[name] = value || "";
  }

  return headers;
}

exports.getMeta = function getMeta (chunks, callback) {
  // We need to convert the array of buffers to a string to
  // parse the header. But strings are memory inefficient compared
  // to buffers so we only convert the least number of chunks to
  // get the user script header.
  var str = '';
  var i = 0;
  var len = chunks.length;

  for (; i < chunks.length; ++i) {
    var header = null;
    str += chunks[i];
    header = /^\/\/ ==UserScript==([\s\S]*?)^\/\/ ==\/UserScript==/m.exec(str)[1];

    if (header) { return callback(parseMeta(header)); }
  }
}

exports.storeScript = function (user, meta, buf, callback, update) {
  var s3 = new AWS.S3();
  var namespace = cleanFilename(meta.namespace || '');
  var scriptName = cleanFilename(meta.name || '');
  var installName = cleanFilename(user.name).toLowerCase() + '/';

  // Can't install a script without a @name (maybe replace with random value)
  if (!scriptName) { return callback(null); }

  if (namespace === cleanFilename(user.name).toLowerCase() || !namespace) {
    installName += scriptName + '.user.js';
  } else {
    installName += namespace + '/' + scriptName + '.user.js';
  }

  Script.findOne({ installName: installName }, function (err, script) {

    if (!script && update) {
      return callback(null);
    } else if (!script) {
      script = new Script({
        name: meta.name,
        about: '',
        installs: 0,
        rating: 0,
        installable: true,
        installName: installName,
        updated: new Date(),
        meta: meta,
        _authorId: user._id
      });
    } else {
      script.updated = new Date();
    }

    script.save(function (err, script) {
      s3.putObject({ Bucket : bucketName, Key : installName, Body : buf },
        function (err, data) { callback(script); });
    });
  });
};

exports.webhook = function (req, res) {
  var payload = null;
  var username = null;
  var reponame = null;
  var repos = {};
  var repo = null;

  res.end(); // close connection

  // Test for know GH webhook ips: https://api.github.com/meta
  if (!req.body.payload ||
    !/192\.30\.252\.(2[0-5][0-5]|1[0-9]{2}|[1-9]?\d)/
    .test(req.connection.remoteAddress)) { return; }

  payload = JSON.parse(req.body.payload);

  // Only accept commits to the master branch
  if (!payload || payload.ref !== 'refs/heads/master') { return; }

  // Gather all the info for the RepoManager
  username = payload.repository.owner.name;
  reponame = payload.repository.name;

  repo = repos[reponame] = {};

  // Find the user that corresponds the repo owner
  User.findOne({ ghUsername: username }, function (err, user) {
    if (!user) { return; }

    // Gather the modified user scripts
    payload.commits.forEach(function (commit) {
      commit.modified.forEach(function (filename) {
        if (filename.substr(-8) === '.user.js') {
          repo[filename] = 'https://raw.github.com/' + username + '/' + 
            reponame + '/master/' + filename;
        }
      });
    });

    // Update modified scripts
    var repoManager = RepoManager.getManager(null, user, repos);
    repoManager.loadScripts(function (){}, true);
  });
};
