/* eslint-disable no-unused-expressions */
/**
 * Tests for create.js
 */
import chai from 'chai';
import request from 'supertest';
import _ from 'lodash';
import server from '../../../app';
import testUtil from '../../../tests/util';
import models from '../../../models';

const should = chai.should();

describe('CREATE PlanConfig version', () => {
  const planConfigs = [
    {
      key: 'dev',
      config: {
        test: 'test1',
      },
      version: 1,
      revision: 1,
      createdBy: 1,
      updatedBy: 1,
    },
    {
      key: 'dev',
      config: {
        test: 'test2',
      },
      version: 1,
      revision: 2,
      createdBy: 1,
      updatedBy: 1,
    },
  ];

  beforeEach((done) => {
    testUtil.clearDb()
      .then(() => models.PlanConfig.create(planConfigs[0]))
      .then(() => models.PlanConfig.create(planConfigs[1]).then(() => done()));
  });
  after((done) => {
    testUtil.clearDb(done);
  });

  describe('Post /projects/metadata/planConfig/{key}/versions/', () => {
    const body = {
      config: {
        'test create': 'test create',
      },
    };

    it('should return 403 if user is not authenticated', (done) => {
      request(server)
        .post('/v5/projects/metadata/planConfig/dev/versions')
        .send(body)
        .expect(403, done);
    });

    it('should return 400 if missing config', (done) => {
      const invalidBody = _.assign({}, body, {
        config: undefined,
      });

      request(server)
      .post('/v5/projects/metadata/planConfig/dev/versions/')
      .set({
        Authorization: `Bearer ${testUtil.jwts.admin}`,
      })
        .send(invalidBody)
        .expect('Content-Type', /json/)
        .expect(400, done);
    });

    it('should return 201 for admin', (done) => {
      request(server)
      .post('/v5/projects/metadata/planConfig/dev/versions/')
      .set({
        Authorization: `Bearer ${testUtil.jwts.admin}`,
      })
        .send(body)
        .expect('Content-Type', /json/)
        .expect(201)
        .end((err, res) => {
          const resJson = res.body;
          should.exist(resJson.id);
          resJson.config.should.be.eql(body.config);
          resJson.key.should.be.eql('dev');
          resJson.revision.should.be.eql(1);
          resJson.version.should.be.eql(2);
          resJson.createdBy.should.be.eql(40051333); // admin
          should.exist(resJson.createdAt);
          resJson.updatedBy.should.be.eql(40051333); // admin
          should.exist(resJson.updatedAt);
          should.not.exist(resJson.deletedBy);
          should.not.exist(resJson.deletedAt);
          done();
        });
    });

    it('should return 403 for member', (done) => {
      request(server)
      .post('/v5/projects/metadata/planConfig/dev/versions/')
      .set({
        Authorization: `Bearer ${testUtil.jwts.member}`,
      })
        .send(body)
        .expect(403, done);
    });
  });
});
