import { MendixPlatformClient } from "mendixplatformsdk";
import { type IModel, projects, domainmodels, microflows, security, datatypes, texts } from "mendixmodelsdk";
import * as fs from "node:fs";

// global constants
const mendixToken = "7fw1mEXi3UUog5vrpgu3wGwDnh2LwNCtRNE23f3KWXnbowMeKRc5bCsu8jwYgz5GeG5Q14oioyCfngtkKFoURgpfxhLhYaF1PmFQ";
const appId = "b35b5408-8fff-457e-9e37-bbc94f02ad4b"; // this is specific for your Mendix app
const outputFileName = "app-logic.json";

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

        // json output
        const appLogic = {
            projectName: appId,
            extractedAt: new Date().toISOString(),
            projectSecurity: await extractProjectSecurity(model),
            modules: await extractModules(model),
        };

        // Write the structured object to a JSON file with pretty printing.
        fs.writeFileSync(outputFileName, JSON.stringify(appLogic, null, 2));
        console.log(`\n✅ Extraction complete. Data saved to ${outputFileName}`);

    } catch (error) {
        console.error("An error occurred during the extraction process:", error);
        process.exit(1);
    }
}

/**
 * Extracts project-level security settings, primarily user roles.
 */
async function extractProjectSecurity(model: IModel): Promise<any> {
    const projectSecurityInterfaces = model.allProjectSecurities();

    if (projectSecurityInterfaces.length === 0) {
        return { securityLevel: "none", userRoles: [] };
    }

    const projectSecurityInterface = projectSecurityInterfaces[0];
    if (!projectSecurityInterface) {
        return { securityLevel: "none", userRoles: [] };
    }

    const projectSecurity = await projectSecurityInterface.load();

    return {
        securityLevel: projectSecurity.securityLevel.toString(),
        checkSecurity: projectSecurity.checkSecurity,
        userRoles: projectSecurity.userRoles.map(role => ({
            name: role.name,
            description: role.description,
            moduleRoles: role.moduleRoles.map(mr => {
                try {
                    return mr.qualifiedName || mr.name;
                } catch {
                    return "Unknown";
                }
            })
        })),
    };
}

/**
 * Iterates over all modules in the project and extracts their specific components.
 */
async function extractModules(model: IModel): Promise<any[]> {
    const modulesData: any[] = [];
    for (const module of model.allModules()) {
        console.log(`- Processing module: ${module.name}`);

        modulesData.push({
            name: module.name,
            domainModel: await extractDomainModel(module),
            microflows: await extractMicroflows(module),
            security: await extractModuleSecurity(module),
        });
    }
    return modulesData;
}

/**
 * Extract module security settings
 */
async function extractModuleSecurity(module: projects.IModule): Promise<any> {
    const moduleSecurity = module.moduleSecurity;
    if (!moduleSecurity) return null;

    return {
        moduleRoles: moduleSecurity.moduleRoles.map(role => ({
            name: role.name,
        }))
    };
}

/**
 * Extract domain model (entities and associations)
 */
async function extractDomainModel(module: projects.IModule): Promise<any> {
    const domainModel = module.domainModel;
    if (!domainModel) return { entities: [], associations: [] };

    const entities = [];
    for (const entityInterface of domainModel.entities) {
        try {
            const entity = await entityInterface.load();

            entities.push({
                name: entity.name,
                documentation: entity.documentation || "",
                generalization: entity.generalization instanceof domainmodels.Generalization ?
                    entity.generalization.generalizationQualifiedName : null,

                attributes: entity.attributes.map(attr => ({
                    name: attr.name,
                    type: extractAttributeTypeFromAttr(attr.type),
                    documentation: attr.documentation || "",
                    value: extractValueType(attr.value)
                })),

                validationRules: entity.validationRules.map(rule => ({
                    attribute: rule.attributeQualifiedName || "Unknown",
                    ruleType: rule.ruleInfo.constructor.name,
                    errorMessage: extractText(rule.errorMessage)
                })),

                eventHandlers: entity.eventHandlers.map(handler => ({
                    moment: handler.moment.toString(),
                    event: handler.event.toString(),
                    microflow: handler.microflowQualifiedName || "",
                    passEventObject: handler.passEventObject,
                    raiseErrorOnFalse: handler.raiseErrorOnFalse
                })),

                indexes: entity.indexes.map(index => ({
                    dataStorageGuid: index.dataStorageGuid,
                    attributes: index.attributes.map(attr => attr.attribute?.name || "Unknown")
                })),

                accessRules: entity.accessRules.map(rule => ({
                    documentation: rule.documentation || "",
                    defaultMemberAccessRights: rule.defaultMemberAccessRights.toString(),
                    allowCreate: rule.allowCreate,
                    allowDelete: rule.allowDelete,
                    moduleRoles: rule.moduleRoles.map(r => r.name),
                    xPathConstraint: rule.xPathConstraint || ""
                }))
            });
        } catch (error) {
            console.error(`  ⚠️  Error loading entity: ${error}`);
        }
    }

    const associations = [];
    for (const assocInterface of domainModel.associations) {
        try {
            const assoc = await assocInterface.load();

            associations.push({
                name: assoc.name,
                documentation: assoc.documentation || "",
                parent: assoc.parent.name,
                child: assoc.child.name,
                type: assoc.type.toString(),
                owner: assoc.owner.toString(),
                deleteBehavior: {
                    parentDelete: assoc.deleteBehavior.parentDeleteBehavior.toString(),
                    childDelete: assoc.deleteBehavior.childDeleteBehavior.toString()
                }
            });
        } catch (error) {
            console.error(`  ⚠️  Error loading association: ${error}`);
        }
    }

    return { entities, associations };
}

/**
 * Extract attribute type information
 */
function extractAttributeType(type: datatypes.DataType): any {
    if (type instanceof datatypes.StringType) {
        return {
            type: "String",
        };
    } else if (type instanceof datatypes.IntegerType) {
        return { type: "Integer" };
    } else if (type instanceof datatypes.EnumerationType) {
        return { type: "Enumeration" };
    } else if (type instanceof datatypes.DecimalType) {
        return { type: "Decimal" };
    } else if (type instanceof datatypes.BooleanType) {
        return { type: "Boolean" };
    } else if (type instanceof datatypes.DateTimeType) {
        return {
            type: "DateTime",
        };
    } else if (type instanceof datatypes.EnumerationType) {
        return {
            type: "Enumeration",
            enumeration: type.enumerationQualifiedName
        };
    } else if (type instanceof datatypes.FloatType) {
        return { type: "Float" };
    } else if (type instanceof datatypes.BinaryType) {
        return { type: "Binary" };
    } else if (type instanceof datatypes.ListType) {
        return { type: "List" };
    }

    return { type: type.constructor.name };
}

/**
 * Extract attribute type from domainmodels.AttributeType
 */
function extractAttributeTypeFromAttr(type: domainmodels.AttributeType): any {
    if (type instanceof domainmodels.StringAttributeType) {
        return { type: "String", length: type.length };
    } else if (type instanceof domainmodels.IntegerAttributeType) {
        return { type: "Integer" };
    } else if (type instanceof domainmodels.LongAttributeType) {
        return { type: "Long" };
    } else if (type instanceof domainmodels.DecimalAttributeType) {
        return { type: "Decimal" };
    } else if (type instanceof domainmodels.BooleanAttributeType) {
        return { type: "Boolean" };
    } else if (type instanceof domainmodels.DateTimeAttributeType) {
        return { type: "DateTime", localized: type.localizeDate };
    } else if (type instanceof domainmodels.EnumerationAttributeType) {
        return { type: "Enumeration", enumeration: type.enumerationQualifiedName };
    } else if (type instanceof domainmodels.AutoNumberAttributeType) {
        return { type: "AutoNumber" };
    } else if (type instanceof domainmodels.BinaryAttributeType) {
        return { type: "Binary" };
    } else if (type instanceof domainmodels.HashedStringAttributeType) {
        return { type: "HashedString" };
    }
    return { type: type.constructor.name };
}

/**
 * Extract value type from domainmodels.ValueType
 */
function extractValueType(value: domainmodels.ValueType | null): any {
    if (!value) return null;

    if (value instanceof domainmodels.StoredValue) {
        return { type: "StoredValue", defaultValue: value.defaultValue };
    } else if (value instanceof domainmodels.CalculatedValue) {
        return { type: "CalculatedValue", microflow: value.microflowQualifiedName };
    }
    return { type: value.constructor.name };
}

/**
 * Extract text translations
 */
function extractText(text: texts.Text): any {
    return {
        translations: text.translations.map(t => ({
            languageCode: t.languageCode,
            text: t.text
        }))
    };
}

/**
 * Extract expression as string
 */
function extractExpression(expression: string): string {
    return expression;
}

/**
 * Extract all microflows in a module
 */
async function extractMicroflows(module: projects.IModule): Promise<any[]> {
    const microflowsData: any[] = [];

    for (const docInterface of module.documents) {
        if (docInterface.structureTypeName === "Microflows$Microflow") {
            try {
                const microflowInterface = docInterface as microflows.IMicroflow;
                const microflow = await microflowInterface.load();

                console.log(`  🔄 Extracting microflow: ${microflow.name}`);

                microflowsData.push({
                    name: microflow.name,
                    qualifiedName: microflow.qualifiedName || "",
                    documentation: microflow.documentation || "",
                    returnType: microflow.microflowReturnType ?
                        extractDataType(microflow.microflowReturnType) : "Nothing",

                    security: {
                        allowedRoles: microflow.allowedModuleRolesQualifiedNames || [],
                        applyEntityAccess: microflow.applyEntityAccess,
                        allowConcurrentExecution: microflow.allowConcurrentExecution
                    },

                    parameters: extractParameters(microflow),
                    activities: extractActivities(microflow),
                    flows: extractFlows(microflow)
                });
            } catch (error) {
                console.error(`  ⚠️  Error loading microflow: ${error}`);
            }
        }
    }

    return microflowsData;
}

/**
 * Extract data type information
 */
function extractDataType(dataType: datatypes.DataType): any {
    if (dataType instanceof datatypes.EntityType) {
        return {
            type: "Entity",
            entity: dataType.entityQualifiedName
        };
    } else if (dataType instanceof datatypes.ObjectType) {
        return {
            type: "Object",
            entity: dataType.entityQualifiedName
        };
    } else if (dataType instanceof datatypes.ListType) {
        return {
            type: "List",
            entity: dataType.entityQualifiedName
        };
    } else if (dataType instanceof datatypes.StringType) {
        return { type: "String" };
    } else if (dataType instanceof datatypes.IntegerType) {
        return { type: "Integer" };
    } else if (dataType.constructor.name.includes("Type")) {
        return { type: dataType.constructor.name.replace("Type", "") };
    }

    return { type: dataType.toString() };
}

/**
 * Extract microflow parameters
 */
function extractParameters(microflow: microflows.Microflow): any[] {
    const parameters: any[] = [];

    for (const obj of microflow.objectCollection.objects) {
        if (obj instanceof microflows.MicroflowParameterObject) {
            parameters.push({
                name: obj.name,
                type: extractDataType(obj.variableType),
                documentation: obj.documentation || ""
            });
        }
    }

    return parameters;
}

/**
 * Extract all activities from a microflow
 */
function extractActivities(microflow: microflows.Microflow): any[] {
    const activities: any[] = [];

    for (const obj of microflow.objectCollection.objects) {
        let activityData: any = null;

        // Action Activities
        if (obj instanceof microflows.ActionActivity) {
            activityData = extractActionActivity(obj);
        }
        // Start/End Events
        else if (obj instanceof microflows.StartEvent) {
            activityData = { type: "StartEvent" };
        }
        else if (obj instanceof microflows.EndEvent) {
            activityData = {
                type: "EndEvent",
                returnValue: obj.returnValue
            };
        }
        // Decision (Exclusive Split)
        else if (obj instanceof microflows.ExclusiveSplit) {
            activityData = {
                type: "ExclusiveSplit",
                caption: obj.caption,
                condition: extractSplitCondition(obj.splitCondition)
            };
        }
        // Loops
        else if (obj instanceof microflows.LoopedActivity) {
            activityData = {
                type: "Loop",
                loopVariableName: obj.loopVariableName,
                iteratedList: obj.iteratedListVariableName
            };
        }
        // Note: Merge is a visual element handled by flows, no specific class needed
        // Continue/Break Events
        else if (obj instanceof microflows.ContinueEvent) {
            activityData = { type: "ContinueEvent" };
        }
        else if (obj instanceof microflows.BreakEvent) {
            activityData = { type: "BreakEvent" };
        }
        // Error Events
        else if (obj instanceof microflows.ErrorEvent) {
            activityData = { type: "ErrorEvent" };
        }

        if (activityData) {
            activityData.id = obj.id;
            activities.push(activityData);
        }
    }

    return activities;
}

/**
 * Extract action activity details
 */
function extractActionActivity(activity: microflows.ActionActivity): any {
    const action = activity.action;
    if (!action) return null;

    const baseData = {
        type: "ActionActivity",
        actionType: action.constructor.name,
        caption: activity.caption || "",
        errorHandlingType: action.errorHandlingType?.name || "Abort",
        details: {} as any
    };

    // Object Activities
    if (action instanceof microflows.CreateObjectAction) {
        baseData.details = {
            entity: action.entityQualifiedName || "",
            outputVariable: action.outputVariableName || "",
            changeItems: action.items.map(item => ({
                attribute: item.attributeQualifiedName || "",
                value: item.value || ""
            }))
        };
    }
    else if (action instanceof microflows.ChangeObjectAction) {
        baseData.details = {
            changeObject: action.changeVariableName || "",
            commit: action.commit.toString(),
            refreshInClient: action.refreshInClient,
            changeItems: action.items.map(item => ({
                attribute: item.attributeQualifiedName || "",
                value: item.value || ""
            }))
        };
    }
    else if (action instanceof microflows.RetrieveAction) {
        const source = action.retrieveSource;
        baseData.details = {
            outputVariable: action.outputVariableName || ""
        };

        if (source instanceof microflows.DatabaseRetrieveSource) {
            baseData.details.source = "Database";
            baseData.details.entity = source.entityQualifiedName || "";
            baseData.details.xPathConstraint = source.xPathConstraint || "";
            baseData.details.range = source.range ? {
                type: source.range.constructor.name
            } : null;
        } else if (source instanceof microflows.AssociationRetrieveSource) {
            baseData.details.source = "Association";
            baseData.details.association = source.associationQualifiedName || "";
            baseData.details.startPoint = source.startVariableName || "";
        }
    }
    else if (action instanceof microflows.CommitAction) {
        baseData.details = {
            commitObjects: action.commitVariableName || "",
            refreshInClient: action.refreshInClient,
            withEvents: action.withEvents
        };
    }
    else if (action instanceof microflows.DeleteAction) {
        baseData.details = {
            deleteObject: action.deleteVariableName || "",
            refreshInClient: action.refreshInClient
        };
    }
    else if (action instanceof microflows.RollbackAction) {
        baseData.details = {
            rollbackObject: action.rollbackVariableName || "",
            refreshInClient: action.refreshInClient
        };
    }
    else if (action instanceof microflows.CastAction) {
        baseData.details = {
            outputVariable: action.outputVariableName || ""
        };
    }

    // List Activities
    else if (action instanceof microflows.AggregateListAction) {
        baseData.details = {
            inputList: action.inputListVariableName || "",
            aggregateFunction: action.aggregateFunction.toString(),
            attribute: action.attributeQualifiedName || "",
            outputVariable: action.outputVariableName || ""
        };
    }
    else if (action instanceof microflows.ChangeListAction) {
        baseData.details = {
            changeList: action.changeVariableName || "",
            type: action.type.toString(),
            value: action.value || ""
        };
    }
    else if (action instanceof microflows.CreateListAction) {
        baseData.details = {
            entity: action.entityQualifiedName || "",
            outputVariable: action.outputVariableName || ""
        };
    }
    else if (action instanceof microflows.ListOperationAction) {
        baseData.details = {
            operation: action.operation?.constructor.name || "Unknown",
            outputVariable: action.outputVariableName || ""
        };
    }

    // Variable Activities
    else if (action instanceof microflows.CreateVariableAction) {
        baseData.details = {
            variableName: action.variableName || "",
            dataType: action.variableType ? extractDataType(action.variableType) : "Unknown",
            initialValue: action.initialValue || ""
        };
    }
    else if (action instanceof microflows.ChangeVariableAction) {
        baseData.details = {
            changeVariable: action.changeVariableName || "",
            value: action.value || ""
        };
    }

    // Microflow Calls
    else if (action instanceof microflows.MicroflowCallAction) {
        const microflowCall = action.microflowCall;
        baseData.details = {
            microflow: microflowCall?.microflowQualifiedName || "",
            parameters: microflowCall?.parameterMappings.map(p => ({
                parameter: p.parameterQualifiedName || "",
                argument: p.argument || ""
            })) || [],
            useReturnVariable: action.useReturnVariable,
            outputVariable: action.outputVariableName || ""
        };
    }
    else if (action instanceof microflows.JavaActionCallAction) {
        baseData.details = {
            javaAction: action.javaActionQualifiedName || "",
            parameters: action.parameterMappings.map(p => ({
                parameter: p.parameterQualifiedName || "",
                argument: p.argument || ""
            })),
            outputVariable: action.outputVariableName || ""
        };
    }
    else if (action instanceof microflows.JavaScriptActionCallAction) {
        baseData.details = {
            javaScriptAction: action.javaScriptActionQualifiedName || "",
            parameters: action.parameterMappings.map(p => ({
                parameter: p.parameterQualifiedName || "",
                value: p.parameterValue?.constructor.name || "Unknown"
            })),
            outputVariable: action.outputVariableName || ""
        };
    }

    // Client Activities
    else if (action instanceof microflows.ShowPageAction) {
        baseData.details = {
            page: action.pageSettings?.pageQualifiedName || "",
            passedObject: action.passedObjectVariableName || ""
        };
    }
    else if (action instanceof microflows.ShowMessageAction) {
        baseData.details = {
            template: action.template?.text ? extractText(action.template.text) : null,
            blocking: action.blocking
        };
    }
    else if (action instanceof microflows.CloseFormAction) {
        baseData.details = {
            numberOfPages: action.numberOfPages
        };
    }
    else if (action instanceof microflows.ValidationFeedbackAction) {
        baseData.details = {
            variable: action.objectVariableName || "",
            attribute: action.attributeQualifiedName || "",
            association: action.associationQualifiedName || "",
            template: action.feedbackTemplate?.text ? extractText(action.feedbackTemplate.text) : null
        };
    }

    // Integration Activities
    else if (action instanceof microflows.RestCallAction) {
        baseData.details = {
            httpConfiguration: action.httpConfiguration ? "configured" : "default",
            timeOut: action.timeOut,
            useRequestTimeOut: action.useRequestTimeOut
        };
    }
    else if (action instanceof microflows.WebServiceCallAction) {
        baseData.details = {
            httpConfiguration: action.httpConfiguration ? "configured" : "default"
        };
    }
    // Note: Import/Export mapping actions are handled through different patterns
    // in newer SDK versions. Skipping for now.

    // Other Activities
    else if (action instanceof microflows.LogMessageAction) {
        baseData.details = {
            logLevel: action.level?.name || "Info",
            logNodeName: action.node || "",
            messageTemplate: action.messageTemplate?.text || "",
            includeLatestStackTrace: action.includeLatestStackTrace
        };
    }
    else if (action instanceof microflows.GenerateDocumentAction) {
        baseData.details = {
            documentTemplate: action.documentTemplateQualifiedName || "",
            documentType: action.documentType.toString(),
            fileVariable: action.fileVariableName || ""
        };
    }

    return baseData;
}

/**
 * Extract split condition (for decisions)
 */
function extractSplitCondition(condition: microflows.SplitCondition | null): any {
    if (!condition) return null;

    if (condition instanceof microflows.ExpressionSplitCondition) {
        return {
            type: "Expression",
            expression: condition.expression || ""
        };
    } else if (condition instanceof microflows.RuleSplitCondition) {
        return {
            type: "Rule",
            rule: condition.ruleCall?.ruleQualifiedName || ""
        };
    }

    return { type: condition.constructor.name };
}

/**
 * Extract sequence flows (connections between activities)
 */
function extractFlows(microflow: microflows.Microflow): any[] {
    return microflow.flows.map(flow => ({
        origin: flow.origin?.id || null,
        destination: flow.destination?.id || null,
        originConnectionIndex: flow.originConnectionIndex,
        destinationConnectionIndex: flow.destinationConnectionIndex,
        caseValue: flow instanceof microflows.SequenceFlow ?
            extractCaseValue(flow.caseValue) : null
    }));
}

/**
 * Extract case value (for conditional flows)
 */
function extractCaseValue(caseValue: microflows.CaseValue | null): any {
    if (!caseValue) return null;

    if (caseValue instanceof microflows.EnumerationCase) {
        return {
            type: "Enumeration",
            value: caseValue.value || ""
        };
    } else if (caseValue instanceof microflows.InheritanceCase) {
        return {
            type: "Inheritance",
            value: caseValue.valueQualifiedName || ""
        };
    } else if (caseValue instanceof microflows.NoCase) {
        return { type: "NoCase" };
    }

    return { type: caseValue.constructor.name };
}
main().catch(error => {
    console.log("ERROR: An error occurred.", error);
    process.exit(1);
});