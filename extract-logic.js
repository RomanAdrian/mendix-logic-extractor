import { App, MendixPlatformClient } from "mendixplatformsdk";
import { projects, domainmodels, microflows, security } from "mendixmodelsdk";
import * as fs from "node:fs";
// --- Configuration ---
const mendixToken = "7fw1mEXi3UUog5vrpgu3wGwDnh2LwNCtRNE23f3KWXnbowMeKRc5bCsu8jwYgz5GeG5Q14oioyCfngtkKFoURgpfxhLhYaF1PmFQ";
const tempProjectName = "LearnNowLogicExtractionPro";
const appId = "b35b5408-8fff-457e-9e37-bbc94f02ad4b";
const outputFileName = "app-logic.json";
/**
 * The main function to orchestrate the entire application logic extraction process.
 */
async function main() {
    console.log("Starting Mendix app logic extraction...");
    if (!process.env.MENDIX_TOKEN) {
        console.error("FATAL ERROR: MENDIX_TOKEN environment variable not set.");
        console.error("Please set your Mendix Personal Access Token to the MENDIX_TOKEN environment variable before running this script.");
        process.exit(1);
    }
    const client = new MendixPlatformClient();
    try {
        const project = await client.getApp(appId);
        console.log(`Retrieved app with ID '${appId}'`);
        const workingCopy = await project.createTemporaryWorkingCopy("main");
        console.log(`Successfully created temporary working copy from branch 'main'.`);
        const model = await workingCopy.openModel();
        console.log("Mendix model opened. Extracting logic...");
        // The final structured object that will be converted to JSON.
        const appLogic = {
            projectName: tempProjectName,
            extractedAt: new Date().toISOString(),
            projectSecurity: await extractProjectSecurity(model),
            modules: await extractModules(model),
        };
        // Write the structured object to a JSON file with pretty printing.
        fs.writeFileSync(outputFileName, JSON.stringify(appLogic, null, 2));
        console.log(`\n✅ Extraction complete. Comprehensive logic saved to ${outputFileName}`);
    }
    catch (error) {
        console.error("An error occurred during the extraction process:", error);
    }
}
/**
 * Extracts project-level security settings, primarily user roles.
 */
async function extractProjectSecurity(model) {
    const projectSecurityInterfaces = model.allProjectSecurities();
    if (projectSecurityInterfaces.length === 0) {
        return { securityLevel: "none", userRoles: [] };
    }
    const projectSecurityInterface = projectSecurityInterfaces[0];
    if (!projectSecurityInterface) {
        return { securityLevel: "none", userRoles: [] };
    }
    const loadedSecurity = await projectSecurityInterface.load();
    return {
        securityLevel: loadedSecurity.securityLevel.name,
        userRoles: loadedSecurity.userRoles.map(role => ({
            name: role.name,
            description: role.description,
        })),
    };
}
/**
 * Iterates over all modules in the project and extracts their specific components.
 */
async function extractModules(model) {
    const modulesData = [];
    for (const module of model.allModules()) {
        console.log(`- Processing module: ${module.name}`);
        modulesData.push({
            name: module.name,
            domainModel: await extractDomainModel(module),
            microflows: await extractMicroflows(module),
        });
    }
    return modulesData;
}
/**
 * Extracts the domain model (entities, associations) for a single module.
 */
async function extractDomainModel(module) {
    const domainModel = module.domainModel;
    if (!domainModel)
        return { entities: [], associations: [] };
    const entities = [];
    for (const entityInterface of domainModel.entities) {
        const entity = await entityInterface.load();
        entities.push({
            name: entity.name,
            generalization: entity.generalization ? entity.generalization.containerAsEntity.qualifiedName : null,
            attributes: entity.attributes.map(attr => ({ name: attr.name, type: attr.type.constructor.name.replace("AttributeType", "") })),
            validationRules: entity.validationRules.map(rule => ({
                attribute: rule.attribute.name,
                type: rule.ruleInfo.constructor.name.replace("ValidationRuleInfo", ""),
                message: rule.errorMessage.translations?.[0]?.text ?? "No message specified"
            })),
            eventHandlers: entity.eventHandlers.map(handler => ({
                event: handler.event.constructor.name.replace("Event", ""),
                microflow: handler.microflowQualifiedName
            })),
        });
    }
    const associations = [];
    for (const assocInterface of domainModel.associations) {
        const assoc = await assocInterface.load();
        associations.push({
            name: assoc.name,
            parent: assoc.parent.name,
            child: assoc.child.name,
            type: assoc.type.constructor.name.replace("Association", ""),
            owner: assoc.owner.name,
            parentDeleteBehavior: assoc.deleteBehavior.parentDeleteBehavior.name,
            childDeleteBehavior: assoc.deleteBehavior.childDeleteBehavior.name,
        });
    }
    return { entities, associations };
}
/**
 * Extracts all microflows for a single module.
 */
async function extractMicroflows(module) {
    const microflowsData = [];
    // loop through all documents in the module and check which ones are microflows.
    for (const docInterface of module.documents) {
        if (docInterface.structureTypeName === "Microflows$Microflow") {
            // cast IDocument to IMicroflow
            const microflowInterface = docInterface;
            const microflow = await microflowInterface.load();
            const activities = [];
            for (const obj of microflow.objectCollection.objects) {
                let activityData = null;
                if (obj instanceof microflows.ActionActivity) {
                    const action = obj.action;
                    if (action) {
                        activityData = {
                            type: "ActionActivity",
                            caption: obj.caption,
                            actionType: action.constructor.name.replace("Action", ""),
                            details: {}
                        };
                        if (action instanceof microflows.RetrieveAction) {
                            const source = action.retrieveSource;
                            if (source instanceof microflows.AssociationRetrieveSource)
                                activityData.details.source = source.associationQualifiedName;
                            if (source instanceof microflows.DatabaseRetrieveSource)
                                activityData.details.entity = source.entityQualifiedName;
                        }
                        else if (action instanceof microflows.AggregateListAction) {
                            activityData.details = { function: action.aggregateFunction, list: action.inputListVariableName, output: action.outputVariableName };
                        }
                        else if (action instanceof microflows.CreateObjectAction) {
                            activityData.details.entity = action.entityQualifiedName;
                        }
                        else if (action instanceof microflows.MicroflowCallAction) {
                            activityData.details.microflow = action.microflowCall.microflowQualifiedName;
                        }
                    }
                }
                else if (obj instanceof microflows.ExclusiveSplit) {
                    activityData = { type: "ExclusiveSplit", caption: obj.caption };
                }
                else if (obj instanceof microflows.LoopedActivity) {
                    activityData = { type: "Loop", iterateOver: obj.loopVariableName };
                }
                else if (obj instanceof microflows.StartEvent || obj instanceof microflows.EndEvent) {
                    activityData = { type: obj.constructor.name };
                }
                if (activityData)
                    activities.push(activityData);
            }
            microflowsData.push({
                name: microflow.name,
                returnType: microflow.microflowReturnType.toString(),
                activities
            });
        }
    }
    return microflowsData;
}
main().catch(error => {
    console.log("ERROR: An error occurred.", error);
    process.exit(1);
});
//# sourceMappingURL=extract-logic.js.map