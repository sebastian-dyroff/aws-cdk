import { UserPool } from '@aws-cdk/aws-cognito';
import { AttributeType, BillingMode, Table } from '@aws-cdk/aws-dynamodb';
import { App, RemovalPolicy, Stack } from '@aws-cdk/core';
import { join } from 'path';
import {
  AuthorizationType,
  GraphQLApi,
  KeyCondition,
  MappingTemplate,
  PrimaryKey,
  UserPoolDefaultAction,
  Values,
} from '../lib';

const app = new App();
const stack = new Stack(app, 'aws-appsync-integ');

const userPool = new UserPool(stack, 'Pool', {
  userPoolName: 'myPool',
});

const api = new GraphQLApi(stack, 'Api', {
  name: 'demoapi',
  schemaDefinitionFile: join(__dirname, 'schema.graphql'),
  authorizationConfig: {
    defaultAuthorization: {
      authorizationType: AuthorizationType.USER_POOL,
      userPoolConfig: {
        userPool,
        defaultAction: UserPoolDefaultAction.ALLOW,
      },
    },
    additionalAuthorizationModes: [
      {
        authorizationType: AuthorizationType.API_KEY,
      },
    ],
  },
});

const noneDS = api.addNoneDataSource('None', 'Dummy data source');

noneDS.createResolver({
  typeName: 'Query',
  fieldName: 'getServiceVersion',
  requestMappingTemplate: MappingTemplate.fromString(JSON.stringify({
    version: '2017-02-28',
  })),
  responseMappingTemplate: MappingTemplate.fromString(JSON.stringify({
    version: 'v1',
  })),
});

const customerTable = new Table(stack, 'CustomerTable', {
  billingMode: BillingMode.PAY_PER_REQUEST,
  partitionKey: {
    name: 'id',
    type: AttributeType.STRING,
  },
  removalPolicy: RemovalPolicy.DESTROY,
});
const orderTable = new Table(stack, 'OrderTable', {
  billingMode: BillingMode.PAY_PER_REQUEST,
  partitionKey: {
    name: 'customer',
    type: AttributeType.STRING,
  },
  sortKey: {
    name: 'order',
    type: AttributeType.STRING,
  },
  removalPolicy: RemovalPolicy.DESTROY,
});
const paymentTable =  Table.fromTableName(stack, 'PaymentTable', 'PaymentTable');

const customerDS = api.addDynamoDbDataSource('Customer', 'The customer data source', customerTable);
const orderDS = api.addDynamoDbDataSource('Order', 'The order data source', orderTable);
const paymentDS = api.addDynamoDbDataSource('Payment', 'The payment data source', paymentTable);

customerDS.createResolver({
  typeName: 'Query',
  fieldName: 'getCustomers',
  requestMappingTemplate: MappingTemplate.dynamoDbScanTable(),
  responseMappingTemplate: MappingTemplate.dynamoDbResultList(),
});
customerDS.createResolver({
  typeName: 'Query',
  fieldName: 'getCustomer',
  requestMappingTemplate: MappingTemplate.dynamoDbGetItem('id', 'id'),
  responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
});
customerDS.createResolver({
  typeName: 'Mutation',
  fieldName: 'addCustomer',
  requestMappingTemplate: MappingTemplate.dynamoDbPutItem(PrimaryKey.partition('id').auto(), Values.projecting('customer')),
  responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
});
customerDS.createResolver({
  typeName: 'Mutation',
  fieldName: 'saveCustomer',
  requestMappingTemplate: MappingTemplate.dynamoDbPutItem(PrimaryKey.partition('id').is('id'), Values.projecting('customer')),
  responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
});
customerDS.createResolver({
  typeName: 'Mutation',
  fieldName: 'saveCustomerWithFirstOrder',
  requestMappingTemplate: MappingTemplate.dynamoDbPutItem(
    PrimaryKey
      .partition('order').auto()
      .sort('customer').is('customer.id'),
    Values
      .projecting('order')
      .attribute('referral').is('referral')),
  responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
});
customerDS.createResolver({
  typeName: 'Mutation',
  fieldName: 'removeCustomer',
  requestMappingTemplate: MappingTemplate.dynamoDbDeleteItem('id', 'id'),
  responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
});

const ops = [
  { suffix: 'Eq', op: KeyCondition.eq},
  { suffix: 'Lt', op: KeyCondition.lt},
  { suffix: 'Le', op: KeyCondition.le},
  { suffix: 'Gt', op: KeyCondition.gt},
  { suffix: 'Ge', op: KeyCondition.ge},
];
for (const {suffix, op} of ops) {
  orderDS.createResolver({
    typeName: 'Query',
    fieldName: 'getCustomerOrders' + suffix,
    requestMappingTemplate: MappingTemplate.dynamoDbQuery(op('customer', 'customer')),
    responseMappingTemplate: MappingTemplate.dynamoDbResultList(),
  });
}
orderDS.createResolver({
  typeName: 'Query',
  fieldName: 'getCustomerOrdersFilter',
  requestMappingTemplate: MappingTemplate.dynamoDbQuery(
    KeyCondition.eq('customer', 'customer').and(KeyCondition.beginsWith('order', 'order'))),
  responseMappingTemplate: MappingTemplate.dynamoDbResultList(),
});
orderDS.createResolver({
  typeName: 'Query',
  fieldName: 'getCustomerOrdersBetween',
  requestMappingTemplate: MappingTemplate.dynamoDbQuery(
    KeyCondition.eq('customer', 'customer').and(KeyCondition.between('order', 'order1', 'order2'))),
  responseMappingTemplate: MappingTemplate.dynamoDbResultList(),
});

paymentDS.createResolver({
  typeName: 'Query',
  fieldName: 'getPayment',
  requestMappingTemplate: MappingTemplate.dynamoDbGetItem('id', 'id'),
  responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
});
paymentDS.createResolver({
  typeName: 'Mutation',
  fieldName: 'savePayment',
  requestMappingTemplate: MappingTemplate.dynamoDbPutItem(PrimaryKey.partition('id').is('id'), Values.projecting('payment')),
  responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
});

const httpDS = api.addHttpDataSource('http', 'The http data source', 'https://aws.amazon.com/');

httpDS.createResolver({
  typeName: 'Mutation',
  fieldName: 'doPostOnAws',
  requestMappingTemplate: MappingTemplate.fromString(`{
    "version": "2018-05-29",
    "method": "POST",
    # if full path is https://api.xxxxxxxxx.com/posts then resourcePath would be /posts
    "resourcePath": "/path/123",
    "params":{
        "body": $util.toJson($ctx.args),
        "headers":{
            "Content-Type": "application/json",
            "Authorization": "$ctx.request.headers.Authorization"
        }
    }
  }`),
  responseMappingTemplate: MappingTemplate.fromString(`
    ## Raise a GraphQL field error in case of a datasource invocation error
    #if($ctx.error)
      $util.error($ctx.error.message, $ctx.error.type)
    #end
    ## if the response status code is not 200, then return an error. Else return the body **
    #if($ctx.result.statusCode == 200)
        ## If response is 200, return the body.
        $ctx.result.body
    #else
        ## If response is not 200, append the response to error block.
        $utils.appendError($ctx.result.body, "$ctx.result.statusCode")
    #end
  `),
});

app.synth();
