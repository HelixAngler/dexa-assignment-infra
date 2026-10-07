/* global __ENV */
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 1,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.05'],
  },
};

const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:80';

export default function () {
  const response = http.get(`${BASE_URL}/api/attendance/health`);
  check(response, {
    'health endpoint responds with 200': (result) => result.status === 200,
  });
  sleep(1);
}
