import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const fileUrl = body.file_url;
    const docType = body.doc_type; // 'fuel_receipt' | 'bol'
    if (!fileUrl) return Response.json({ error: 'file_url required' }, { status: 400 });

    let prompt, schema;
    if (docType === 'fuel_receipt') {
      prompt = 'Extract the following fields from this fuel receipt image. Use null for any field you cannot read. Do not guess.';
      schema = {
        type: 'object',
        properties: {
          vendor: { type: 'string' },
          receipt_date: { type: 'string' },
          receipt_time: { type: 'string' },
          city: { type: 'string' },
          state: { type: 'string' },
          gallons: { type: 'number' },
          amount: { type: 'number' },
          receipt_number: { type: 'string' }
        }
      };
    } else if (docType === 'bol') {
      prompt = 'Extract the following fields from this bill of lading image. Use null for any field you cannot read. Do not guess.';
      schema = {
        type: 'object',
        properties: {
          bol_number: { type: 'string' },
          shipper: { type: 'string' },
          receiver: { type: 'string' },
          commodity: { type: 'string' },
          origin_city: { type: 'string' },
          origin_state: { type: 'string' },
          destination_city: { type: 'string' },
          destination_state: { type: 'string' },
          pickup_appointment: { type: 'string' },
          delivery_appointment: { type: 'string' }
        }
      };
    } else {
      return Response.json({ error: 'Invalid doc_type' }, { status: 400 });
    }

    const result = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt,
      file_urls: [fileUrl],
      response_json_schema: schema,
      model: 'automatic'
    });

    return Response.json({ extracted: result, file_url: fileUrl, doc_type: docType });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}