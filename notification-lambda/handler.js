/**
 * AeroLink Notification Service - AWS Lambda Handler
 * This function is triggered by Kafka events (BookingCreated, FlightUpdated).
 */

exports.handler = async (event) => {
    console.log('Notification Lambda triggered with event:', JSON.stringify(event, null, 2));

    // In a real scenario, the 'event' object would contain records from Kafka
    // For local demonstration, we process the first record
    try {
        const records = event.records || [];
        
        for (const record of records) {
            // Kafka payload is usually base64 encoded in Lambda triggers
            const payload = JSON.parse(Buffer.from(record.value, 'base64').toString());
            console.log('Processing notification for:', payload.passengerEmail);

            // Logic to send email via Amazon SES
            /*
            await ses.sendEmail({
                Source: 'notifications@aerolink.com',
                Destination: { ToAddresses: [payload.passengerEmail] },
                Message: {
                    Subject: { Data: 'AeroLink Booking Confirmation' },
                    Body: { Text: { Data: `Your booking ${payload.bookingId} is confirmed.` } }
                }
            }).promise();
            */
            
            console.log(`Notification sent to ${payload.passengerEmail} for booking ${payload.bookingId}`);
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Notifications processed successfully' }),
        };
    } catch (error) {
        console.error('Error processing notifications:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to process notifications' }),
        };
    }
};
