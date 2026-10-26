export const CHARGE_PAYMENT_METHOD_MUTATION = `
  mutation ChargePaymentMethod($input: ChargePaymentMethodInput!) {
    chargePaymentMethod(input: $input) {
      clientMutationId
      transaction {
        id
        legacyId
        status
        amount {
          value
          currencyCode
        }
        orderId
        statusHistory {
          ... on GatewayRejectedEvent {
            gatewayRejectionReason
          }
          ... on ProcessorDeclinedEvent {
            processorResponseCode
            processorResponseText
          }
        }
      }
    }
  }
`;

export const SEARCH_TRANSACTION_BY_ORDER_ID_QUERY = `
  query SearchTransactionsByOrderId($input: TransactionSearchInput!) {
    search {
      transactions(input: $input) {
        edges {
          node {
            id
            legacyId
            status
            orderId
            amount {
              value
              currencyCode
            }
            statusHistory {
              ... on GatewayRejectedEvent {
                gatewayRejectionReason
              }
              ... on ProcessorDeclinedEvent {
                processorResponseCode
                processorResponseText
              }
            }
          }
        }
      }
    }
  }
`;