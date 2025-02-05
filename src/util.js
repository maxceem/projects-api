
/* globals Promise */
/*
 * Copyright (C) 2016 TopCoder Inc., All Rights Reserved.
 */
/**
 * This is utils file.
 * @author TCDEVELOPER
 * @version 1.0
 */


import _ from 'lodash';
import config from 'config';
import urlencode from 'urlencode';
import elasticsearch from 'elasticsearch';
import Promise from 'bluebird';
// import AWS from 'aws-sdk';

import { ADMIN_ROLES, TOKEN_SCOPES, EVENT, PROJECT_MEMBER_ROLE } from './constants';

const exec = require('child_process').exec;
const models = require('./models').default;
const tcCoreLibAuth = require('tc-core-library-js').auth;

const m2m = tcCoreLibAuth.m2m(config);

const util = _.cloneDeep(require('tc-core-library-js').util(config));

// the client modifies the config object, so always passed the cloned object
let esClient = null;

_.assignIn(util, {
  /**
   * Build API error
   * @param {string} message the API error message
   * @param {number} status the API status code
   * @returns {Error} the built API error
   */
  buildApiError: (message, status) => {
    const apiErr = new Error(message);
    apiErr.status = status || 500;
    return apiErr;
  },
  /**
   * Handle error
   * @param   {String}    msg               the default error message
   * @param   {Error}     err               the err
   * @param   {Object}    req               the request
   * @param   {Function}  next              the next function
   * @returns {Function}                    next function with error
   */
  handleError: (msg, err, req, next) => {
    req.log.error({
      message: msg,
      error: err,
    });
    const apiErr = new Error(msg);
    _.assign(apiErr, {
      status: _.get(err, 'status', 500),
      details: _.get(err, 'details', msg),
    });
    return next(apiErr);
  },
  /**
   * Validates if filters are valid
   * @param  {object}   filters         object with filters
   * @param  {array}    validValues     valid filter values
   * @return {boolean}                  true if filters are valid otherwise false
   */
  isValidFilter: (filters, validValues) => {
    let valid = true;
    _.each(_.keys(filters), (k) => {
      if (valid && _.indexOf(validValues, k) < 0) {
        valid = false;
      }
    });
    return valid;
  },
  /**
   * Helper funtion to verify if user has specified role
   * @param  {object} req  Request object that should contain authUser
   * @param  {string} role specified role
   * @return {boolean}      true/false
   */
  hasRole: (req, role) => {
    const isMachineToken = _.get(req, 'authUser.isMachine', false);
    const tokenScopes = _.get(req, 'authUser.scopes', []);
    if (isMachineToken) {
      if (_.indexOf(tokenScopes, TOKEN_SCOPES.CONNECT_PROJECT_ADMIN) >= 0) return true;
      return false;
    }
    let roles = _.get(req, 'authUser.roles', []);
    roles = roles.map(s => s.toLowerCase());
    return _.indexOf(roles, role.toLowerCase()) >= 0;
  },
  /**
   * Helper funtion to verify if user has specified roles
   * @param  {object} req  Request object that should contain authUser
   * @param  {Array} roles specified roles
   * @return {boolean}      true/false
   */
  hasRoles: (req, roles) => {
    const isMachineToken = _.get(req, 'authUser.isMachine', false);
    const tokenScopes = _.get(req, 'authUser.scopes', []);
    if (isMachineToken) {
      if (_.indexOf(tokenScopes, TOKEN_SCOPES.CONNECT_PROJECT_ADMIN) >= 0) return true;
      return false;
    }
    let authRoles = _.get(req, 'authUser.roles', []);
    authRoles = authRoles.map(s => s.toLowerCase());
    return _.intersection(authRoles, roles.map(r => r.toLowerCase())).length > 0;
  },
  /**
   * Helper funtion to find intersection (case insensitive) between two arrays
   * @param  {Array} array1 first array of strings
   * @param  {Array} array2 second array of strings
   * @return {boolean}      true/false
   */
  hasIntersection: (array1, array2) => {
    const lowercased = array1.map(s => s.toLowerCase());
    return _.intersection(lowercased, array2.map(r => r.toLowerCase())).length > 0;
  },
  /**
   * Helper funtion to verify if user has admin roles
   * @param  {object} req  Request object that should contain authUser
   * @return {boolean}      true/false
   */
  hasAdminRole: (req) => {
    const isMachineToken = _.get(req, 'authUser.isMachine', false);
    const tokenScopes = _.get(req, 'authUser.scopes', []);
    if (isMachineToken) {
      if (_.indexOf(tokenScopes, TOKEN_SCOPES.CONNECT_PROJECT_ADMIN) >= 0) return true;
      return false;
    }
    let roles = _.get(req, 'authUser.roles', []);
    roles = roles.map(s => s.toLowerCase());
    return _.intersection(roles, ADMIN_ROLES.map(r => r.toLowerCase())).length > 0;
  },

  /**
   * Parses query fields and groups them per table
   * @param  {array}      queryFields     list of query fields
   * @param  {Object}     allowedFields   the allowed fields
   * @return {object}                     the parsed fields
   */
  parseFields: (queryFields, allowedFields) => {
    const fields = _.cloneDeep(allowedFields);
    if (queryFields.length) {
      // remove any inavlid fields
      fields.projects = _.intersection(queryFields, allowedFields.projects);
      fields.project_members = _.filter(queryFields, f => f.indexOf('members.') === 0);
      // remove members. prefix
      fields.project_members = _.map(fields.project_members, f => f.substring(8));
      // remove any errorneous fields
      fields.project_members = _.intersection(fields.project_members, allowedFields.project_members);
      if (fields.project_members.length === 0 && _.indexOf(queryFields, 'members') > -1) {
        fields.project_members = allowedFields.project_members;
      }
      // remove attachments if not requested
      if (fields.attachments && _.indexOf(queryFields, 'attachments') === -1) {
        fields.attachments = null;
      }
    }
    return fields;
  },

  /**
   * Moves file from source to destination
   * @param  {object} req    request object
   * @param  {object} source source object
   * @param  {string} dest   destination url
   * @return {promise}       promise
   */
  s3FileTransfer: (req, source, dest) => new Promise((resolve, reject) => {
    const cmdStr = _.join([
      'aws s3 mv',
      `"${source}"`,
      `"${dest}"`,
      '--region us-east-1',
    ], ' ');
    exec(cmdStr, (error, stdout, stderr) => {
      req.log.debug(`s3FileTransfer: stdout: ${stdout}`);
      req.log.debug(`s3FileTransfer: stderr: ${stderr}`);
      if (error !== null) {
        req.log.error(`exec error: ${error}`);
        return reject(error);
      }
      return resolve({ success: true });
    });
  }),


  /**
   * retrieve download urls for all attachments
   * @param  {Object}     req         original request
   * @param  {String}     filePath    the file path
   * @return {String}                 the download url
   */
  getFileDownloadUrl: (req, filePath) => {
    if (!filePath) {
      return Promise.reject(new Error('file path empty'));
    }
    let fileServiceUrl = config.get('fileServiceEndpoint');
    if (fileServiceUrl.substr(-1) !== '/') fileServiceUrl += '/';
    // get presigned Url
    const httpClient = util.getHttpClient(req);
    httpClient.defaults.headers.common.Authorization = req.headers.authorization;
    return httpClient.post(`${fileServiceUrl}downloadurl`, {
      param: {
        filePath,
      },
    })
      .then((resp) => {
        req.log.debug('Retreiving Presigned Url resp: ', JSON.stringify(resp.data, null, 2));
        if (resp.status !== 200 || resp.data.result.status !== 200) {
          return Promise.reject(new Error('Unable to fetch pre-signed url'));
        }
        return [
          filePath,
          resp.data.result.content.preSignedURL,
        ];
      });
  },
  getProjectAttachments: (req, projectId) => {
    let attachments = [];
    let attachmentsPromise;
    if (util.hasAdminRole(req)) {
      attachmentsPromise = models.ProjectAttachment.getActiveProjectAttachments(projectId);
    } else {
      attachmentsPromise = models.ProjectAttachment.getAttachmentsForUser(projectId, req.authUser.userId);
    }
    return attachmentsPromise
      .then((_attachments) => {
        // if attachments were requested
        if (_attachments) {
          attachments = _attachments;
        }
        return attachments;
      });
  },

  /**
   * Get machine to machine token.
   * @returns {Promise} promise which resolves to the m2m token
   */
  getM2MToken: () => m2m.getMachineToken(config.AUTH0_CLIENT_ID, config.AUTH0_CLIENT_SECRET),

  /**
   * Fetches the topcoder user details using the given JWT token.
   *
   * @param {Number}  userId        id of the user to be fetched
   * @param {String}  jwtToken      JWT token of the admin user or JWT token of the user to be fecthed
   * @param {Object}  logger        logger to be used for logging purposes
   *
   * @return {Promise}              promise which resolves to the user's information
   */
  getTopcoderUser: (userId, jwtToken, logger) => {
    const httpClient = util.getHttpClient({ id: `userService_${userId}`, log: logger });
    httpClient.defaults.timeout = 3000;
    httpClient.defaults.headers.common.Accept = 'application/json';
    httpClient.defaults.headers.common['Content-Type'] = 'application/json';
    httpClient.defaults.headers.common.Authorization = `Bearer ${jwtToken}`;
    return httpClient.get(`${config.identityServiceEndpoint}users`, {
      params: {
        filter: `id=${userId}`,
      },
    })
      .then((response) => {
        if (response.data && response.data.result
        && response.data.result.status === 200 && response.data.result.content
        && response.data.result.content.length === 1) {
          return response.data.result.content[0];
        }
        return null;
      });
  },

  /**
   * Return the initialized elastic search client
   * @return {Object}           the elasticsearch client instance
   */
  getElasticSearchClient: () => {
    if (esClient) return esClient;
    const esHost = config.get('elasticsearchConfig.host');
    if (/.*amazonaws.*/.test(esHost)) {
      esClient = elasticsearch.Client({
        apiVersion: config.get('elasticsearchConfig.apiVersion'),
        hosts: esHost,
        connectionClass: require('http-aws-es'), // eslint-disable-line global-require
        // amazonES: {
        //   region: 'us-east-1',
        //   credentials: new AWS.EnvironmentCredentials('AWS'),
        // },
      });
    } else {
      esClient = new elasticsearch.Client(_.cloneDeep(config.elasticsearchConfig));
    }
    return esClient;
  },

  /**
   * Return the searched resource from elastic search
   * @param resource resource name
   * @param query    search query
   * @param index    index to search from
   * @return {Object}           the searched resource
   */
  fetchFromES: Promise.coroutine(function* (resource, query, index) { // eslint-disable-line func-names
    let INDEX = config.get('elasticsearchConfig.metadataIndexName');
    let TYPE = config.get('elasticsearchConfig.metadataDocType');
    if (index === 'timeline') {
      INDEX = config.get('elasticsearchConfig.timelineIndexName');
      TYPE = config.get('elasticsearchConfig.timelineDocType');
    } else if (index === 'project') {
      INDEX = config.get('elasticsearchConfig.indexName');
      TYPE = config.get('elasticsearchConfig.docType');
    }

    const data = query ? (yield esClient.search({ index: INDEX, type: TYPE, body: query })) :
    (yield esClient.search({ index: INDEX, type: TYPE }));
    if (data.hits.hits.length > 0 && data.hits.hits[0].inner_hits) {
      return data.hits.hits[0].inner_hits;
    }

    return data.hits.hits.length > 0 ? data.hits.hits[0]._source : {  // eslint-disable-line no-underscore-dangle
      productTemplates: [],
      forms: [],
      projectTemplates: [],
      planConfigs: [],
      priceConfigs: [],
      projectTypes: [],
      productCategories: [],
      orgConfigs: [],
      milestoneTemplates: [],
    };
  }),

  /**
   * Return the searched resource from elastic search PROJECT index
   * @param resource resource name
   * @param query    search query
   * @param index    index to search from
   * @return {Array}           the searched resource
   */
  fetchByIdFromES: Promise.coroutine(function* (resource, query, index) { // eslint-disable-line func-names
    let INDEX = config.get('elasticsearchConfig.indexName');
    let TYPE = config.get('elasticsearchConfig.docType');
    if (index === 'timeline') {
      INDEX = config.get('elasticsearchConfig.timelineIndexName');
      TYPE = config.get('elasticsearchConfig.timelineDocType');
    } else if (index === 'metadata') {
      INDEX = config.get('elasticsearchConfig.metadataIndexName');
      TYPE = config.get('elasticsearchConfig.metadataDocType');
    }

    return (yield esClient.search({
      index: INDEX,
      type: TYPE,
      _source: false,
      body: query,
    })).hits.hits;
  }),


  /**
   * Retrieve member details from userIds
   */
  getMemberDetailsByUserIds: Promise.coroutine(function* (userIds, logger, requestId) { // eslint-disable-line func-names
    try {
      const token = yield this.getM2MToken();
      const httpClient = this.getHttpClient({ id: requestId, log: logger });
      if (logger) {
        logger.trace(userIds);
      }
      return httpClient.get(`${config.memberServiceEndpoint}/_search`, {
        params: {
          query: `${userIds.join(urlencode(' OR ', 'utf8'))}`,
          fields: 'userId,handle,firstName,lastName,email',
        },
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      }).then(res => _.get(res, 'data.result.content', null));
    } catch (err) {
      return Promise.reject(err);
    }
  }),

  /**
   * Retrieve member details from userIds
   */
  getUserRoles: Promise.coroutine(function* (userId, logger, requestId) { // eslint-disable-line func-names
    try {
      const token = yield this.getM2MToken();
      const httpClient = this.getHttpClient({ id: requestId, log: logger });
      return httpClient.get(`${config.identityServiceEndpoint}roles`, {
        params: {
          filter: `subjectID=${userId}`,
        },
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      }).then(res => _.get(res, 'data.result.content', [])
          .map(r => r.roleName));
    } catch (err) {
      return Promise.reject(err);
    }
  }),

  /**
  * Merge two JSON objects. For array fields, the target will be replaced by source.
  * @param {Object} targetObj the target object
  * @param {Object} sourceObj the source object
  * @param {Object} mergeExceptions list of keys which should be exempted from merge
  * @returns {Object} the merged object
  */
  mergeJsonObjects: (targetObj, sourceObj, mergeExceptions) =>
    // eslint-disable-next-line consistent-return
    _.mergeWith({}, targetObj, sourceObj, (target, source, key) => {
      // Overwrite the array or merge exception keys
      if (_.isArray(source) || (mergeExceptions && mergeExceptions.indexOf(key) !== -1)) {
        return source;
      }
    }),

    /**
     * Send resource to kafka bus
     * @param  {object} req  Request object
     * @param  {String} key  the event key
     * @param  {String} name  the resource name
     * @param  {object} resource  the resource
    */
    sendResourceToKafkaBus: Promise.coroutine(function* (req, key, name, resource) {    // eslint-disable-line
      req.log.debug('Sending event to Kafka bus for resource %s %s', name, resource.id || resource.key);
      // emit event
      req.app.emit(key, { req, resource: _.assign({ resource: name }, resource) });
    }),

  /**
   * Add userId to project
   * @param  {object} req  Request object that should contain project info and user info
   * @param  {object} member  the member to be added to project
  */
  addUserToProject: Promise.coroutine(function* (req, member) {    // eslint-disable-line
    const members = req.context.currentProjectMembers;

    // check if member is already registered
    const existingMember = _.find(members, m => m.userId === member.userId);
    if (existingMember) {
      const err = new Error(`User already registered for role: ${existingMember.role}`);
      err.status = 400;
      return Promise.reject(err);
    }

    req.log.debug('creating member', member);
    let newMember = null;
    // register member

    return models.ProjectMember.create(member)
    .then((_newMember) => {
      newMember = _newMember.get({ plain: true });
      // publish event
      req.app.services.pubsub.publish(
        EVENT.ROUTING_KEY.PROJECT_MEMBER_ADDED,
        newMember,
        { correlationId: req.id },
      );

      return newMember;
    })
    .catch((err) => {
      req.log.error('Unable to register ', err);
      return Promise.reject(err);
    });
  }),

  /**
   * Lookup user handles from emails
   * @param {Object}  req        request
   * @param {Array}   userEmails user emails
   * @param {Boolean} isPattern  flag to indicate that pattern matching is required or not
   * @return {Promise} promise
   */
  lookupUserEmails: (req, userEmails, isPattern = false) => {
    req.log.debug(`identityServiceEndpoint: ${config.get('identityServiceEndpoint')}`);
    let filter = _.map(userEmails, i => `email=${i}`).join(' OR ');
    if (isPattern) {
      filter += '&like=true';
    }
    req.log.trace('filter for users api call', filter);
    return util.getM2MToken()
    .then((token) => {
      req.log.debug(`Bearer ${token}`);
      const httpClient = util.getHttpClient({ id: req.id, log: req.log });
      return httpClient.get(`${config.get('identityServiceEndpoint')}users`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        params: {
          fields: 'handle,id,email',
          filter,
        },
        // set longer timeout as default 3000 could be not enough for identity service response
        timeout: 15000,
      })
      .then((response) => {
        const data = _.get(response, 'data.result.content', null);
        if (!data) { throw new Error('Response does not have result.content'); }
        req.log.debug('UserHandle response', data);
        return data;
      });
    });
  },

  /**
   * Filter only members of topcoder team
   * @param {Array}  members        project members
   * @return {Array} tpcoder project members
   */
  getTopcoderProjectMembers: members => _(members).filter(m => m.role !== PROJECT_MEMBER_ROLE.CUSTOMER),

  /**
  * Set paginated header and respond with data
  * @param {Object} req HTTP request
  * @param {Object} res HTTP response
  * @param {Object} data Data for which pagination need to be applied
  * @return {Array} data rows to be returned
  */
  setPaginationHeaders: (req, res, data) => {
    const totalPages = Math.ceil(data.count / data.pageSize);
    let fullUrl = `${req.protocol}://${req.get('host')}${req.url.replace(`&page=${data.page}`, '')}`;
  // URL formatting to add pagination parameters accordingly
    if (fullUrl.indexOf('?') === -1) {
      fullUrl += '?';
    } else {
      fullUrl += '&';
    }

  // Pagination follows github style
    if (data.count > 0) { // Set Pagination headers only if there is data to paginate
      let link = ''; // Content for Link header

    // Set first and last page in Link header
      link += `<${fullUrl}page=1>; rel="first"`;
      link += `, <${fullUrl}page=${totalPages}>; rel="last"`;

    // Set Prev-Page only if it's not first page and within page limits
      if (data.page > 1 && data.page <= totalPages) {
        const prevPage = (data.page - 1);
        res.set({
          'X-Prev-Page': prevPage,
        });
        link += `, <${fullUrl}page=${prevPage}>; rel="prev"`;
      }

    // Set Next-Page only if it's not Last page and within page limits
      if (data.page < totalPages) {
        const nextPage = (_.parseInt(data.page) + 1);
        res.set({
          'X-Next-Page': (_.parseInt(data.page) + 1),
        });
        link += `, <${fullUrl}page=${nextPage}>; rel="next"`;
      }

    // Allow browsers access pagination data in headers
      let accessControlExposeHeaders = res.get('Access-Control-Expose-Headers') || '';
      accessControlExposeHeaders += accessControlExposeHeaders ? ', ' : '';
      accessControlExposeHeaders += 'X-Page, X-Per-Page, X-Total, X-Total-Pages';

      res.set({
        'Access-Control-Expose-Headers': accessControlExposeHeaders,
        'X-Page': data.page,
        'X-Per-Page': data.pageSize,
        'X-Total': data.count,
        'X-Total-Pages': totalPages,
        Link: link,
      });
    }
  // Return the data after setting pagination headers
    res.json(data.rows);
  },

  /**
   * Check if the following model exist
   * @param {Object} keyInfo key information, it includes version and key
   * @param {String} modelName name of model
   * @param {Object} model model that will be checked
   * @param {String} referredEntityName entity that referred by this model
   * @return {Promise} promise whether the record exists or not
   */
  checkModel: (keyInfo, modelName, model, referredEntityName) => {
    if (_.isNil(keyInfo)) {
      return Promise.resolve(null);
    }

    const { version, key } = keyInfo;
    let errorMessage = '';

    if (!_.isNil(version) && !_.isNil(key)) {
      errorMessage = `${modelName} with key ${key} and version ${version}`
        + ` referred in the ${referredEntityName} is not found`;
      return (model.findOne({
        where: {
          key,
          version,
        },
      })).then((record) => {
        if (_.isNil(record)) {
          const apiErr = new Error(errorMessage);
          apiErr.status = 400;
          throw apiErr;
        }
      });
    } else if (_.isNil(version) && !_.isNil(key)) {
      errorMessage = `${modelName} with key ${key}`
        + ` referred in ${referredEntityName} is not found`;
      return (model.findOne({
        where: {
          key,
        },
      })).then((record) => {
        if (_.isNil(record)) {
          const apiErr = new Error(errorMessage);
          apiErr.status = 400;
          throw apiErr;
        }
      });
    }

    return Promise.resolve(null);
  },
});

export default util;
