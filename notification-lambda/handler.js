const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const logger = require('./logger');

const ses = new SESClient({ region: process.env.AWS_REGION || 'us-east-1' });

const SES_SENDER = process.env.SES_SENDER || 'notifications@aerolink.com';

const buildEmailParams = (payload) => ({
  Source: SES_SENDER,
  Destination: {
    ToAddresses: [payload.passengerEmail],
  },
  Message: {
    Subject: {
      Data: `AeroLink Booking Confirmation — ${payload.bookingId}`,
    },
    Body: {
      Text: {
        Data: [
          `Dear Passenger,`,
          ``,
          `Your booking has been confirmed.`,
          ``,
          `Booking ID : ${payload.bookingId}`,
          `Flight     : ${payload.flightId}`,
          ``,
          `Thank you for choosing AeroLink.`,
        ].join('\n'),
      },
      Html: {
        Data: `
          <h2>Booking Confirmed</h2>
          <p>Dear Passenger,</p>
          <p>Your booking has been confirmed with the following details:</p>
          <table>
            <tr><td><strong>Booking ID</strong></td><td>${payload.bookingId}</td></tr>
            <tr><td><strong>Flight</strong></td><td>${payload.flightId}</td></tr>
          </table>
          <p>Thank you for choosing AeroLink.</p>
        `,
      },
    },
  },
});

exports.handler = async (event) => {
  const records = event.records || [];
  logger.info('Notification Lambda triggered', { recordCount: records.length });

  const results = [];

  for (const record of records) {
    try {
      const payload = JSON.parse(Buffer.from(record.value, 'base64').toString());

      if (payload.type !== 'CREATED') {
        logger.info('Skipping non-booking event', { type: payload.type });
        continue;
      }

      logger.info('Sending booking confirmation email', {
        to: payload.passengerEmail,
        bookingId: payload.bookingId,
        flightId: payload.flightId,
      });

      await ses.send(new SendEmailCommand(buildEmailParams(payload)));

      logger.info('Email sent successfully', {
        to: payload.passengerEmail,
        bookingId: payload.bookingId,
      });

      results.push({ bookingId: payload.bookingId, status: 'sent' });
    } catch (err) {
      logger.error('Failed to send notification', { error: err.message });
      results.push({ status: 'failed', error: err.message });
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Notifications processed', results }),
  };
};
