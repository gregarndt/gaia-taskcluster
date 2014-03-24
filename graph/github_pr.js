/**
Creates a graph from a github pull request.

@module graph/github
*/
var Promise = require('promise');
var GraphFactory = require('taskcluster-client/factory/graph');

var TASKGRAPH_PATH = 'taskgraph.json';

var DEFAULT_PROVISIONER =
  process.env.TASKCLUSTER_PROVISIONER_ID || 'aws-provisioner';

var DEFAULT_WORKER_TYPE =
  process.env.TASKCLUSTER_WORKER_TYPE || 'ami-f44128c4';

function pullRequestResultsetId(pr) {
  var id =
    // prefix so pull requests are distinct from other things
    'pr-' +
    // pull request number is unique per project
    pr.number +
    '-' +
    // repository is is unique globally on github and will stay the same
    // even if the repository is renamed
    pr.base.repo.id;

  return id;
}

exports.pullRequestResultsetId = pullRequestResultsetId;

var FAKE_EMAIL_DOMAIN = 'github.taskcluster.net';

/**
Fetch the github email address based on the login of the user.
@param {Object} github api interface.
@param {String} login username for github.
*/
function fetchOwnerFromLogin(github, login) {
  var getUser = Promise.denodeify(github.user.getFrom.bind(github.user));
  return getUser({ user: login }).then(function(user) {
    // if we have an email immediately return it
    if (user.email) return user.email;
    // otherwise construct the ghetto fake email for takscluster
    return user.login + '@' + FAKE_EMAIL_DOMAIN;
  });
}

module.exports.fetchOwnerFromLogin = fetchOwnerFromLogin;

/**
Fetch the graph (but do not decorate it) from the pull request.

@return {Promise<Object>} raw graph as defined in the repository.
*/
function fetchGraph(github, pullRequest) {
  var content = Promise.denodeify(
    github.repos.getContent.bind(github.repos)
  );

  return content({
    user: pullRequest.head.user.login,
    repo: pullRequest.head.repo.name,
    path: TASKGRAPH_PATH
  }).then(function(contents) {
    return JSON.parse(new Buffer(contents.content, 'base64'));
  });
}

module.exports.fetchGraph = fetchGraph;

/**
Decorate the given graph object with the pull request data.

@return {Promise<Object>} graph result object.
*/
function decorateGraph(graph, github, pullRequest) {
  // environment variables these do not override if set in the task.
  var envs = {
    CI: true,
    // we use the label since it's available from the PR but not the
    // prefix (so this would be master instead of repo:master)
    GH_BRANCH: pullRequest.base.label.split(':').pop(),
    GH_COMMIT: pullRequest.base.sha,
    GH_PULL_REQUEST: 'true',
    GH_PULL_REQUEST_NUMBER: pullRequest.number,
    GH_REPO_SLUG: pullRequest.base.repo.full_name
  };

  // metadata will override any values in the template.
  var meta = {};

  // tag data is always overridden
  var tags = {
    commit: pullRequest.head.sha,
    repository: pullRequest.base.repo.html_url,
    pullRequest: pullRequest.html_url,
    githubUsername: pullRequest.head.user.login,
    treeherderResultset: pullRequestResultsetId(pullRequest)
  };

  return fetchOwnerFromLogin(
    github,
    pullRequest.head.user.login
  ).then(function(owner) {
    // owner email based on the github data available.
    meta.owner = owner;

    // iterate through all the tasks and decorate them with the details.
    Object.keys(graph.tasks).forEach(function(name) {
      var task = graph.tasks[name];
      var definition = task.task;
      var taskEnvs = definition.payload.env = definition.payload.env || {};
      var taskTags = definition.tags = definition.tags || {};
      var taskMeta = definition.metadata = definition.metadata || {};

      /**
      We add defaults to the provisionerId and workerType mostly so we can change
      these in the server configuration until we have stabilized a bit more.
      */
      definition.provisionerId =
        definition.provisionerId || DEFAULT_PROVISIONER;

      definition.workerType =
        definition.workerType || DEFAULT_WORKER_TYPE;

      var key;
      for (key in tags) {
        taskTags[key] = tags[key];
      }

      for (key in meta) {
        taskMeta[key] = meta[key];
      }

      for (key in envs) {
        if (!(key in taskEnvs)) {
          taskEnvs[key] = envs[key];
        }
      }
    });

    // we need to override this in all cases so we get notifications for the
    // individual tasks and for the overall graph progress...
    graph.routing = process.env.TASKCLUSTER_ROUTING_KEY + '.';

    // cast to promise and fill in the rest of fields with defaults if not set...
    return Promise.cast(GraphFactory.create(graph));
  });
}

module.exports.decorateGraph = decorateGraph;