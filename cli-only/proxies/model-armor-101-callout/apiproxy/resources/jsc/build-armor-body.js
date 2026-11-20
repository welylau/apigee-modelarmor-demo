// JSON-encode the prompt for the Model Armor REST call: {"userPromptData":{"text":"..."}}
var prompt = String(context.getVariable('private.prompt'));
context.setVariable('private.armor_body', JSON.stringify({ userPromptData: { text: prompt } }));
