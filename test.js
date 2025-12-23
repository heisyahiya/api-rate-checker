// a1topup-test.js - Minimal standalone test
const axios = require('axios');

// ========================================
// A1Topup Service Class
// ========================================
class A1TopupService {
  constructor() {
    // Your credentials here
    this.username = '505738';
    this.password = '4ff6olp2';
    this.baseURL = 'https://business.a1topup.com/recharge';
    this.timeout = 30000; // 30 seconds
  }

  async recharge(params) {
    const { number, amount, operatorCode, circleCode, orderid } = params;

    try {
      const response = await axios.get(`${this.baseURL}/api`, {
        params: {
          username: this.username,
          pwd: this.password,
          circlecode: circleCode,
          operatorcode: operatorCode,
          number: number,
          amount: amount,
          orderid: orderid,
          format: 'json'
        },
        timeout: this.timeout
      });

      return this.parseResponse(response.data);
    } catch (error) {
      throw new Error(`Recharge failed: ${error.message}`);
    }
  }

  async checkStatus(orderid) {
    try {
      const response = await axios.get(`${this.baseURL}/status`, {
        params: {
          username: this.username,
          pwd: this.password,
          orderid: orderid,
          format: 'json'
        },
        timeout: this.timeout
      });

      return this.parseResponse(response.data);
    } catch (error) {
      throw new Error(`Status check failed: ${error.message}`);
    }
  }

  async checkBalance() {
    try {
      const response = await axios.get(`${this.baseURL}/balance`, {
        params: {
          username: this.username,
          pwd: this.password,
          format: 'json'
        },
        timeout: this.timeout
      });

      return response.data;
    } catch (error) {
      throw new Error(`Balance check failed: ${error.message}`);
    }
  }

  parseResponse(data) {
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (e) {
        return { status: 'Unknown', raw: data };
      }
    }

    return {
      txid: data.txid,
      status: data.status,
      opid: data.opid,
      number: data.number,
      amount: data.amount,
      orderid: data.orderid,
      isSuccess: data.status === 'Success',
      isPending: data.status === 'Pending',
      isFailure: data.status === 'Failure'
    };
  }

  static generateOrderId() {
    return `ORD${Date.now()}${Math.floor(Math.random() * 10000)}`;
  }
}

// ========================================
// Operator & Circle Codes
// ========================================
const OPERATORS = {
  PREPAID: {
    AIRTEL: 'A',
    JIO: 'RC',
    VODAFONE: 'V',
    IDEA: 'I',
    BSNL_TOPUP: 'BT',
    BSNL_STV: 'BR'
  },
  POSTPAID: {
    AIRTEL: 'PAT',
    JIO: 'JPP',
    VODAFONE: 'VP',
    IDEA: 'IP',
    BSNL: 'BP'
  }
};

const CIRCLES = {
  DELHI: '5'
};

// ========================================
// Simple direct tests (no CONFIG object)
// ========================================
async function runTests() {
  console.log('\n=== A1TOPUP SIMPLE TEST ===');

  const service = new A1TopupService();

  // Set test values directly here
  const testMobile = '9800000000'; // replace with valid test number
  const testAmount = 10;

  // 1. Check balance
  try {
    console.log('\n[1] Checking balance...');
    const bal = await service.checkBalance();
    console.log('Balance response:', bal);
  } catch (e) {
    console.error('Balance error:', e.message);
  }

  // 2. Prepaid recharge (Jio)
  let prepaidOrderId = null;
  try {
    console.log('\n[2] Prepaid Jio recharge...');
    prepaidOrderId = A1TopupService.generateOrderId();

    const res = await service.recharge({
      number: testMobile,
      amount: testAmount,
      operatorCode: OPERATORS.PREPAID.JIO,
      circleCode: CIRCLES.DELHI,
      orderid: prepaidOrderId
    });

    console.log('Prepaid response:', res);
  } catch (e) {
    console.error('Prepaid error:', e.message);
  }

  // 3. Postpaid recharge (Airtel)
  let postpaidOrderId = null;
  try {
    console.log('\n[3] Postpaid Airtel bill payment...');
    postpaidOrderId = A1TopupService.generateOrderId();

    const res = await service.recharge({
      number: testMobile,
      amount: testAmount,
      operatorCode: OPERATORS.POSTPAID.AIRTEL,
      circleCode: CIRCLES.DELHI,
      orderid: postpaidOrderId
    });

    console.log('Postpaid response:', res);
  } catch (e) {
    console.error('Postpaid error:', e.message);
  }

  // 4. Check status of prepaid (if we have order id)
  if (prepaidOrderId) {
    try {
      console.log('\n[4] Checking status for prepaid order:', prepaidOrderId);
      const status = await service.checkStatus(prepaidOrderId);
      console.log('Status response:', status);
    } catch (e) {
      console.error('Status error:', e.message);
    }
  }

  console.log('\n=== TEST FINISHED ===\n');
}

runTests().catch(console.error);
